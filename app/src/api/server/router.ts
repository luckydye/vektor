import type { Next } from "hono";
import { apiRoutes } from "#api/routes.ts";
import { auth, authTrustedOrigins } from "#auth";
import { getPublicEnv, isTrustProxyEnabled } from "#config";
import { isNoAuthMode, LOCAL_SESSION, LOCAL_USER } from "#noAuth";
import { appLogger } from "#observability/logger.ts";
import { type CompiledRoute, compileRoute, matchRoute, sortRoutes } from "./matcher.ts";
import type { ApiContext, ApiRouteMethod, ApiRouteModule } from "./types.ts";

const compiledRoutes: CompiledRoute[] = sortRoutes(
  apiRoutes.map(({ pattern, module }) => compileRoute(pattern, module)),
);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Trusted origins, normalized to `proto://host[:port]` for exact comparison. */
const trustedOrigins = new Set(
  authTrustedOrigins.flatMap((value) => {
    try {
      return [new URL(value).origin];
    } catch {
      return [];
    }
  }),
);

/**
 * CSRF guard: browsers attach the session cookie to cross-site requests (and
 * always send an `Origin` header on cross-site non-GET requests), so unsafe
 * methods from an untrusted origin are rejected outright. Requests without an
 * `Origin` header (curl, access tokens, CalDAV clients, same-origin GET
 * navigations) pass through — they are not forgeable by a hostile web page.
 * This is an explicit second layer on top of the SameSite cookie default.
 */
function isCrossSiteForgery(c: ApiContext, method: string): boolean {
  if (SAFE_METHODS.has(method)) return false;
  const origin = c.req.header("origin");
  if (!origin) return false;
  if (trustedOrigins.has(origin)) return false;
  // Same-origin fallback for deployments without VEKTOR_SITE_URL: the browser
  // sets Host to the target server, so Origin host === Host implies the
  // request came from a page served by this very host.
  try {
    return new URL(origin).host !== c.req.header("host");
  } catch {
    return true;
  }
}

function clientIp(c: ApiContext): string {
  const socketIp = c.env.incoming.socket?.remoteAddress ?? "";
  if (!isTrustProxyEnabled()) return socketIp;
  const forwardedFor = c.req.header("x-forwarded-for");
  return forwardedFor?.split(",").at(-1)?.trim() || socketIp;
}

async function hydrateRequestContext(c: ApiContext): Promise<void> {
  const headers = new Headers(c.req.raw.headers);
  const ip = clientIp(c);
  if (ip) {
    headers.set("x-forwarded-for", ip);
  } else {
    headers.delete("x-forwarded-for");
  }

  let user: App.Locals["user"] = null;
  let session: App.Locals["session"] = null;
  if (isNoAuthMode()) {
    user = LOCAL_USER;
    session = LOCAL_SESSION;
  } else {
    const authenticated = await auth.api.getSession({ headers });
    if (authenticated) {
      user = authenticated.user;
      session = authenticated.session;
    }
  }

  c.set("publicEnv", getPublicEnv());
  c.set("requestHeaders", headers);
  c.set("session", session);
  c.set("user", user);
}

function isApiPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/.well-known/caldav" ||
    pathname === "/.well-known/vektor"
  );
}

function resolveHandler(module: ApiRouteModule, method: string) {
  const handler = module[method as ApiRouteMethod] ?? module.ALL;
  return handler;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Hono middleware that serves the migrated API routes. Non-API paths fall
 * through to the next handler (e.g. the Astro frontend handler, when mounted).
 */
export async function apiRouter(
  c: ApiContext,
  next: Next,
): Promise<Response | undefined> {
  const pathname = c.req.path;
  if (!isApiPath(pathname)) {
    await next();
    return;
  }

  const match = matchRoute(compiledRoutes, pathname);
  if (!match) {
    return jsonError(404, "Not found");
  }
  c.set("params", match.params);

  const method = c.req.method.toUpperCase();
  if (isCrossSiteForgery(c, method)) {
    return jsonError(403, "Cross-origin request rejected");
  }

  const handler = resolveHandler(match.module, method);
  if (!handler) {
    const allowed = Object.keys(match.module)
      .filter((key) => key !== "ALL")
      .join(", ");
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: allowed } },
    );
  }

  try {
    await hydrateRequestContext(c);
    const result = await handler(c);

    if (!(result instanceof Response)) {
      appLogger.error("API handler returned a non-Response value", { path: pathname });
      return jsonError(500, "Internal server error");
    }

    return result;
  } catch (error) {
    appLogger.error("Unhandled API route error", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(500, "Internal server error");
  }
}
