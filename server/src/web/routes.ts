import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  isAccessDenied,
  ResourceUnavailableError,
  ShareLinkPasswordRequiredError,
} from "#acl/errors.ts";
import {
  authenticateShareLink,
  SHARE_COOKIE,
  verifyAccess,
  withShareLink,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { resolveRequestIdentity } from "#acl/session.ts";
import { resolveClientIp } from "#api/clientIp.ts";
import { checkRateLimit, SHARE_LINK_ROUTE_PATTERN } from "#api/rateLimit.ts";
import type { ApiBindings, ApiContext } from "#api/server/types.ts";
import { getPublicEnv, isHttpsSite } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import {
  getDocument,
  getDocumentBySlug,
  getDocumentChildren,
  getDocumentContent,
} from "#db/space/documents.ts";
import { getUploadImageAspectRatio } from "#db/space/files.ts";
import {
  getRevisionContent,
  resolvePublishedDocumentContent,
} from "#db/space/revisions.ts";
import { getSpaceBySlug, getUserSpaceRole } from "#db/space/spaces.ts";
import apiMd from "#docs/api.md" with { type: "text" };
import extensionsMd from "#docs/extensions.md" with { type: "text" };
import permissionsMd from "#docs/permissions.md" with { type: "text" };
import { documentTitle } from "#documents/title.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import {
  LAST_VISITED_SPACE_KEY,
  resolveActiveSpaceSlug,
} from "#utils/activeSpace.server.ts";
import { isReservedSpaceSlug } from "#utils/slug.ts";
import { parseSidebarWidth, SIDEBAR_WIDTH_KEY } from "#utils/sidebarState.ts";
import { requestScope } from "#utils/requestScope.ts";
import { DOCS_SECTIONS, type DocsSection, isDocsSection } from "./docs/navigation.ts";
import { renderMarkdown } from "./docs/markdown.ts";
import { preferredLang } from "./locale.ts";
import type { WebRuntime } from "./runtime.ts";

const DOCS_MARKDOWN: Record<DocsSection, string> = {
  api: apiMd,
  permissions: permissionsMd,
  extensions: extensionsMd,
};

/** The docs are static, so each is rendered once: highlighting is too costly to repeat per request. */
const renderedDocsCache = new Map<DocsSection, ReturnType<typeof renderMarkdown>>();

function renderedDocs(section: DocsSection) {
  let rendered = renderedDocsCache.get(section);
  if (!rendered) {
    rendered = renderMarkdown(DOCS_MARKDOWN[section]);
    renderedDocsCache.set(section, rendered);
  }
  return rendered;
}

const LAST_VISITED_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

/** The URL is the credential: never cache a shared page, never index it. */
const SHARE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

function basicAuthPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? null : decoded.slice(separator + 1);
}

function basicRealm(name: string | null): string {
  const printable = (name ?? "").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "");
  return printable.trim().slice(0, 64) || "Shared page";
}

/** What a page response needs from the request, resolved once. */
function requestInfo(c: ApiContext) {
  const url = new URL(c.req.url);
  return {
    url,
    lang: preferredLang(c.req.header("accept-language")),
    user: c.var.user,
    session: c.var.session,
    publicEnv: c.var.publicEnv,
    platform: c.var.platform,
  };
}

type RequestInfo = ReturnType<typeof requestInfo>;

/**
 * The frontend's pages: server-rendered components behind the same Hono app as
 * the API. Registered after the API router and the static assets, so those win
 * for the paths they own, and static routes come before the space catch-all.
 */
export function registerWebRoutes(app: Hono<ApiBindings>, web: WebRuntime): void {
  // The identity every page needs, resolved ahead of the handler the way the API
  // does it. The scope stays open until the response body is produced.
  app.use("*", async (c, next) => {
    const platform: Platform = c.var.platform;
    const { user, session } = await resolveRequestIdentity(platform, c.req.raw.headers);
    c.set("publicEnv", getPublicEnv());
    c.set("user", user);
    c.set("session", session);
    const response = await requestScope.withinResponse(async () => {
      await next();
      return c.res;
    });
    c.res = response;
  });

  function notFoundPage(info: RequestInfo, headers: Record<string, string> = {}) {
    return web.html(
      "notFound",
      { lang: info.lang },
      { lang: info.lang, title: "Page not found · Vektor", publicEnv: info.publicEnv },
      { status: 404, headers },
    );
  }

  app.notFound(async (c) => notFoundPage(requestInfo(c)));

  app.get("/", async (c) => {
    const { session, user, platform } = requestInfo(c);
    if (!session) return c.redirect("/login");

    const activeSpaceSlug = await resolveActiveSpaceSlug(
      platform,
      user?.id,
      getCookie(c, LAST_VISITED_SPACE_KEY),
    );
    // No reachable space means there is nothing for a space-scoped route to
    // render, so the overview takes over: it states the empty case and offers
    // creation only when the account is allowed it.
    return c.redirect(activeSpaceSlug ? `/${activeSpaceSlug}` : "/spaces");
  });

  // Landing spot for the tabbed-mode new-tab button. Manifest members hold a
  // fixed URL and cannot name the active space, so this resolves the space the
  // same way a bare "/" does and hands off to that space's composer. Two
  // segments on purpose: a single one would fall inside the home tab's "/:space"
  // scope, and Chrome hides the new-tab button when its target is in that scope.
  app.get("/new/document", async (c) => {
    const { session, user, platform } = requestInfo(c);
    if (!session) return c.redirect("/login");

    const activeSpaceSlug = await resolveActiveSpaceSlug(
      platform,
      user?.id,
      getCookie(c, LAST_VISITED_SPACE_KEY),
    );
    return c.redirect(activeSpaceSlug ? `/${activeSpaceSlug}/new` : "/spaces");
  });

  app.get("/login", async (c) => {
    const { url, lang, publicEnv } = requestInfo(c);
    // Resolved against this page, so only a path on this origin survives as a destination.
    const next = url.searchParams.get("next");
    let nextUrl: URL | null = null;
    try {
      nextUrl = next ? new URL(next, url) : null;
    } catch {
      // Not a URL at all: the same answer as no destination.
    }
    const callbackURL =
      nextUrl && nextUrl.origin === url.origin ? nextUrl.pathname + nextUrl.search : "/";
    const loginHint = url.searchParams.get("login_hint") ?? undefined;

    return web.html(
      "login",
      { lang, callbackURL, loginHint },
      { lang, title: "Vektor", publicEnv },
    );
  });

  // Opened in the system browser by the desktop app, with the SHA-256 of a secret
  // only the app holds.
  app.get("/desktop-login", async (c) => {
    const { url, lang, user, session, publicEnv } = requestInfo(c);
    const challenge = url.searchParams.get("challenge") ?? "";
    if (!/^[0-9a-f]{64}$/.test(challenge)) {
      return new Response("Invalid sign-in link", { status: 400 });
    }
    if (!session || !user) {
      return c.redirect(
        `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
      );
    }

    return web.html(
      "desktopLogin",
      { lang, challenge, name: user.name, email: user.email },
      { lang, title: "Vektor", publicEnv },
    );
  });

  app.get("/spaces", async (c) => {
    const { url, lang, user, session, publicEnv } = requestInfo(c);
    if (!session) return c.redirect("/login");

    // Server-side so a linked `?tab=users` renders that page rather than flashing
    // the space overview first. Which tabs exist is still the island's call.
    const initialTab = url.searchParams.get("tab") === "users" ? "users" : "spaces";
    return web.html(
      "spaces",
      {
        replicaScope: user?.id ? `user:${user.id}` : "public",
        lang,
        initialTab,
      },
      { lang, title: "Spaces", publicEnv },
    );
  });

  app.get("/docs", async (c) => {
    const { lang, publicEnv } = requestInfo(c);
    return web.html(
      "docsIndex",
      { currentPath: "/docs" },
      { lang, title: "Docs - Vektor", publicEnv },
    );
  });

  app.get("/docs/:section", async (c, next) => {
    const { lang, publicEnv } = requestInfo(c);
    const section = c.req.param("section");

    // Raw markdown source for a /docs page, for agent/tool consumption.
    if (section.endsWith(".md")) {
      const name = section.slice(0, -".md".length);
      if (!isDocsSection(name)) return new Response("Not found", { status: 404 });
      return new Response(DOCS_MARKDOWN[name], {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    if (!isDocsSection(section)) {
      await next();
      return;
    }

    const { html, headings } = renderedDocs(section);
    return web.html(
      "docsMarkdown",
      {
        currentPath: `/docs/${section}`,
        html,
        outline: headings.filter((heading) => heading.depth === 2),
      },
      { lang, title: DOCS_SECTIONS[section], publicEnv },
    );
  });

  app.get("/:spaceSlug/s/:linkId", (c) => sharePage(c, undefined));
  app.get("/:spaceSlug/s/:linkId/*", (c) => {
    const documentPath = c.req.path.split("/").slice(4).join("/");
    return sharePage(c, documentPath || undefined);
  });

  async function sharePage(c: ApiContext, requestedDocumentId: string | undefined) {
    const info = requestInfo(c);
    const { platform, lang } = info;
    const spaceSlug = c.req.param("spaceSlug") ?? "";
    const linkId = c.req.param("linkId") ?? "";

    const respond = (response: Response) => withHeaders(response, SHARE_HEADERS);
    const notFound = () => notFoundPage(info, SHARE_HEADERS);

    // The page bypasses API middleware, and a share link resolves to no session
    // user, so the address is the caller here.
    const limit = checkRateLimit({
      pattern: SHARE_LINK_ROUTE_PATTERN,
      method: c.req.method,
      ip: resolveClientIp(c.env.clientAddress, c.req.header("x-forwarded-for")),
    });
    if (limit && !limit.allowed) {
      appLogger.warn("Share link rate limit exceeded", {
        key: limit.key,
        blocked: limit.blocked,
      });
      return respond(
        new Response("Too many requests", {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        }),
      );
    }

    let link: Awaited<ReturnType<typeof authenticateShareLink>>;
    try {
      link = await authenticateShareLink(
        platform,
        spaceSlug,
        linkId,
        basicAuthPassword(c.req.header("Authorization") ?? null),
      );
    } catch (error) {
      if (error instanceof ResourceUnavailableError) return notFound();
      if (error instanceof ShareLinkPasswordRequiredError) {
        return respond(
          new Response("Password required", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Basic realm="${basicRealm(error.linkName)}", charset="UTF-8"`,
            },
          }),
        );
      }
      throw error;
    }

    const store = await openSpaceStore(platform, link.spaceId);
    const documentId = requestedDocumentId || link.resourceId;

    // Ambient grants must not widen a document share to the optional child path.
    if (link.resourceType === ResourceType.DOCUMENT && documentId !== link.resourceId) {
      return notFound();
    }

    try {
      await verifyAccess(
        platform,
        link.spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        link.aclUserId,
        Permission.VIEWER,
      );
    } catch (error) {
      if (isAccessDenied(error)) return notFound();
      throw error;
    }

    const record = await getDocument(store, documentId);
    if (!record) return notFound();
    const publishedRev = record.publishedRev;
    if (publishedRev === null) return notFound();

    const htmlRenderedDocumentTypes = new Set(["document", "record"]);
    const rendersAsHtml = htmlRenderedDocumentTypes.has(record.type ?? "document");
    const publishedContent = await getRevisionContent(store, documentId, publishedRev);
    if (publishedContent === null) return notFound();

    const children =
      link.resourceType === ResourceType.DOCUMENT_TREE
        ? await getDocumentChildren(store, documentId, {
            userId: link.aclUserId,
            userGroups: [],
          })
        : [];

    const title = documentTitle(record, lang);
    const response = await web.html(
      "share",
      {
        title,
        spaceId: link.spaceId,
        documentId,
        publishedContent: rendersAsHtml ? publishedContent : null,
        documentType: record.type ?? "document",
        children: children.map((child) => ({
          href: `/${spaceSlug}/s/${linkId}/${child.id}`,
          title: documentTitle(child, lang),
        })),
      },
      { lang, title, publicEnv: info.publicEnv },
    );

    // Attachment requests need the link and, when protected, proof of its password.
    setCookie(c, SHARE_COOKIE, withShareLink(c.req.header("cookie") ?? null, link.carried), {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttpsSite(),
    });
    return respond(copyPendingCookies(c, response));
  }

  app.get("/:spaceSlug", spacePage);
  app.get("/:spaceSlug/*", spacePage);

  async function spacePage(c: ApiContext) {
    const info = requestInfo(c);
    const { platform, url, lang, user, session } = info;

    const spaceSlug = c.req.param("spaceSlug");
    if (!spaceSlug) return c.redirect("/");
    // A path the app owns that nothing answered — a stale `/assets/` file, an
    // unknown `/docs/` page — is a 404, not a space to look up.
    if (isReservedSpaceSlug(spaceSlug)) return notFoundPage(info);

    /**
     * The one answer a caller who may not see this space gets, whether the slug
     * is refused or resolves to nothing: telling those apart lets anyone
     * enumerate private space slugs, which are creator-chosen and often guessable.
     */
    function spaceUnavailableResponse(): Response {
      if (!session) {
        return new Response(null, { status: 302, headers: { Location: "/login" } });
      }
      return new Response(null, { status: 403, statusText: "Forbidden" });
    }

    // Missing the session is not itself the refusal: a space that grants viewer to
    // the `public` group must render without one, so only the checks below decide.
    const space = await getSpaceBySlug(platform, spaceSlug);
    if (!space) return spaceUnavailableResponse();

    const store = await openSpaceStore(platform, space.id);

    const docSlugMatch = url.pathname.match(/\/doc\/(.+)$/);
    const settingsPath =
      url.pathname === `/${space.slug}/settings` ||
      url.pathname.startsWith(`/${space.slug}/settings/`);

    if (settingsPath) {
      if (!session) return spaceUnavailableResponse();

      try {
        await verifyAccess(
          platform,
          space.id,
          { type: ResourceType.SPACE, id: space.id },
          user?.id ?? "",
          Permission.OWNER,
        );
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        // Use the page boundary's deliberately opaque response for every refusal.
        return spaceUnavailableResponse();
      }
    }

    const storedDocumentRecord = docSlugMatch
      ? await getDocumentBySlug(store, docSlugMatch[1])
      : null;

    /**
     * Viewer verdict for one document, swallowing the ACL failure: answering with
     * transport-specific detail would leak whether the document exists.
     */
    async function holdsDocumentViewerRole(documentId: string): Promise<boolean> {
      try {
        await verifyAccess(
          platform,
          space.id,
          { type: ResourceType.DOCUMENT, id: documentId },
          user?.id ?? null,
          Permission.VIEWER,
        );
        return true;
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        return false;
      }
    }

    /**
     * The addressed document once the per-document check has passed for it, `null`
     * when it has not — nothing resolved, or the caller may not read what did.
     * Every document-derived value below hangs off this.
     */
    const readableDocumentRecord =
      storedDocumentRecord && (await holdsDocumentViewerRole(storedDocumentRecord.id))
        ? storedDocumentRecord
        : null;

    if (!readableDocumentRecord) {
      // Space-wide viewer, or any document/tree/category grant inside the space —
      // a resource-scoped grantee still has to reach the container it lives in.
      // Also the only place an anonymous caller is sent to /login: redirecting on
      // the document verdict would tell a refused slug from an unresolved one.
      try {
        await verifyAccess(
          platform,
          space.id,
          { type: ResourceType.SPACE, id: space.id, anyGrantInSpace: true },
          user?.id ?? null,
          Permission.VIEWER,
        );
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        return spaceUnavailableResponse();
      }
    }

    if (docSlugMatch && !storedDocumentRecord) {
      // A document addressed by its ID redirects to its canonical slug URL,
      // matching the dedicated doc page this catch-all replaced. Gated on viewer:
      // slugs are title-derived, so redirecting anyone else hands out the title.
      const documentById = await getDocument(store, docSlugMatch[1]);
      if (documentById && (await holdsDocumentViewerRole(documentById.id))) {
        return c.redirect(`/${space.slug}/doc/${documentById.slug}${url.search}`);
      }
    }

    // A caller who reached the space but may not read this document renders the
    // shell an unresolved slug produces — a 403 here would confirm the slug exists.
    const documentRecord = readableDocumentRecord
      ? await resolvePublishedDocumentContent(store, {
          ...readableDocumentRecord,
          content: (await getDocumentContent(store, readableDocumentRecord.id)) ?? "",
        })
      : null;
    const initialDocument = documentRecord
      ? JSON.parse(JSON.stringify(documentRecord))
      : undefined;

    if (initialDocument) {
      initialDocument.headerImageAspectRatio = await getUploadImageAspectRatio(
        platform,
        space.id,
        initialDocument.properties.headerImage,
      );
    }

    if (session) {
      setCookie(c, LAST_VISITED_SPACE_KEY, space.slug, {
        path: "/",
        maxAge: LAST_VISITED_MAX_AGE_SECONDS,
        sameSite: "Lax",
        httpOnly: true,
      });
    }

    const userRole = user ? await getUserSpaceRole(platform, space, user.id) : undefined;
    // Serialize Date fields to ISO strings so the server-rendered HTML matches the
    // props the browser hydrates with, which travel as JSON. Without this,
    // data-updated-at / data-created-at attributes differ between server and
    // client, triggering hydration mismatches.
    const initialSpace = JSON.parse(JSON.stringify({ ...space, userRole }));

    const initialSidebarWidth = parseSidebarWidth(getCookie(c, SIDEBAR_WIDTH_KEY));

    const response = await web.html(
      "space",
      {
        url: `${url.pathname}${url.search}`,
        initialSpace,
        initialDocument,
        initialSidebarWidth,
        replicaScope: user?.id ? `user:${user.id}` : "public",
        lang,
      },
      {
        lang,
        title: space.name,
        publicEnv: info.publicEnv,
        brandColor: space.preferences?.brandColor,
        spaceId: space.id,
      },
    );
    return copyPendingCookies(c, response);
  }
}

/**
 * Carries the cookies set on the context onto a response built separately.
 * Hono merges `c.header` and cookie writes into `c.res` only when the handler
 * returns through it, so a handler that builds its own `Response` copies them.
 */
function copyPendingCookies(c: Context, response: Response): Response {
  for (const cookie of c.res.headers.getSetCookie()) {
    response.headers.append("Set-Cookie", cookie);
  }
  return response;
}
