import type { Next } from "hono";
import { resolveIdentity, withIdentityScope } from "#acl/identity.ts";
import { resolveRequestIdentity } from "#acl/session.ts";
import { resolveClientIp } from "#api/clientIp.ts";
import { checkRateLimit, type RateLimitCheck } from "#api/rateLimit.ts";
import { apiRoutes } from "#api/routes.ts";
import { authTrustedOrigins } from "#auth";
import { getPublicEnv } from "#config";
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
  return resolveClientIp(
    c.env.incoming.socket?.remoteAddress,
    c.req.header("x-forwarded-for"),
  );
}

async function hydrateRequestContext(c: ApiContext): Promise<void> {
  const headers = new Headers(c.req.raw.headers);
  const ip = clientIp(c);
  if (ip) {
    headers.set("x-forwarded-for", ip);
  } else {
    headers.delete("x-forwarded-for");
  }

  const { user, session } = await resolveRequestIdentity(headers);

  c.set("publicEnv", getPublicEnv());
  c.set("requestHeaders", headers);
  c.set("session", session);
  c.set("user", user);

  // The request edge, and the only place group resolution is meant to happen:
  // this is what may go to the IdP, so no permission check downstream has to.
  // Every decision in this request then reads the answer out of the scope.
  if (user) {
    await resolveIdentity(user.id);
  }
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

function withRateLimitHeaders(response: Response, limit: RateLimitCheck): Response {
  try {
    response.headers.set("X-Limit-Remaining", String(limit.remaining));
  } catch {
    // A Response proxied from `fetch` (better-auth) has immutable headers, and
    // an advisory hint is not worth reconstructing the body around.
  }
  return response;
}

function rateLimitedResponse(limit: RateLimitCheck): Response {
  return Response.json(
    {
      error: limit.blocked
        ? "API access temporarily disabled for this client"
        : "Too many requests",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(limit.retryAfterSeconds),
        "X-Limit-Remaining": "0",
      },
    },
  );
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

  // Ahead of `hydrateRequestContext` so an over-limit caller is turned away
  // before the session lookup, and ahead of the 405 so a flood of unsupported
  // methods is counted rather than routing freely.
  const limit = checkRateLimit({
    pattern: match.pattern,
    method,
    authorization: c.req.header("authorization"),
    cookie: c.req.header("cookie"),
    ip: clientIp(c),
    jobToken: c.req.header("x-job-token"),
    spaceId: c.req.header("x-space-id") ?? match.params.spaceId,
  });
  if (limit && !limit.allowed) {
    // The key is logged so an operator can name it in VEKTOR_RATE_LIMIT_BLOCK.
    appLogger.warn("API rate limit exceeded", {
      path: pathname,
      method,
      key: limit.key,
      blocked: limit.blocked,
    });
    return rateLimitedResponse(limit);
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
    // One identity cache for the length of this request: a route that gates
    // several resources resolves each caller once, and the staleness bound the
    // IdP sync exists for stays a per-request bound rather than a per-check one.
    const result = await withIdentityScope(async () => {
      await hydrateRequestContext(c);
      return await handler(c);
    });

    if (!(result instanceof Response)) {
      appLogger.error("API handler returned a non-Response value", { path: pathname });
      return jsonError(500, "Internal server error");
    }

    return limit ? withRateLimitHeaders(result, limit) : result;
  } catch (error) {
    appLogger.error("Unhandled API route error", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(500, "Internal server error");
  }
}
