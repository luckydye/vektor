import type { Next } from "hono";
import { AclFailure } from "#acl/errors.ts";
import { withIdentityScope } from "#acl/identity.ts";
import { resolveRequestIdentity } from "#acl/session.ts";
import { resolveClientIp } from "#api/clientIp.ts";
import { aclFailureResponse } from "#api/http.ts";
import {
  checkAddressRateLimit,
  checkRateLimit,
  type RateLimitCheck,
} from "#api/rateLimit.ts";
import { apiRoutes } from "#api/routes.ts";
import { isSshSignedRequest, resolveSshSignedUser } from "#api/sshRequestAuth.ts";
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

  const isSigned = isSshSignedRequest(headers);
  const { user: sessionUser, session } = await resolveRequestIdentity(headers);
  // A signature is only consulted where a session did not answer, and it leaves
  // `session` null: it authenticates one request rather than opening one, and
  // the routes that insist on a real session — SSH key management above all —
  // read that difference.
  const user = sessionUser ?? (isSigned ? await resolveSshSignedUser(c.req.raw) : null);

  c.set("publicEnv", getPublicEnv());
  c.set("requestHeaders", headers);
  c.set("session", session);
  c.set("user", user);
  // The seam with `#acl`: guards read this struct and never the context itself.
  c.set("credentials", {
    jobToken: headers.get("X-Job-Token"),
    // An SSH signature is spent here, on the identity above — leaving it in
    // would have every guard read it as a malformed access token and refuse the
    // request it just authenticated.
    authorization: isSigned ? null : headers.get("Authorization"),
    cookie: headers.get("Cookie"),
    user,
  });
}

/**
 * Git smart HTTP lives under a literal `git` segment inside a space: the second
 * segment is the whole test. It runs on every request the server handles, so it
 * is two index operations rather than a pattern match, and `//git/x` and a space
 * whose own slug is `git` both fall out of the arithmetic rather than needing a
 * case of their own.
 *
 * Kept beside `isApiPath` because both copies of that check must agree: miss
 * one and a clone either 404s as an unknown API path or falls through to Astro.
 */
export function isGitPath(pathname: string): boolean {
  const spaceEnd = pathname.indexOf("/", 1);
  return spaceEnd > 1 && pathname.startsWith("/git/", spaceEnd);
}

function isApiPath(pathname: string): boolean {
  return (
    isGitPath(pathname) ||
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

/** The key is logged so an operator can name it in VEKTOR_RATE_LIMIT_BLOCK. */
function logRateLimit(path: string, method: string, limit: RateLimitCheck): void {
  appLogger.warn("API rate limit exceeded", {
    path,
    method,
    key: limit.key,
    blocked: limit.blocked,
  });
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

  const caller = {
    ip: clientIp(c),
    jobToken: c.req.header("x-job-token"),
    spaceId: c.req.header("x-space-id") ?? match.params.spaceId,
  };

  // Ahead of `hydrateRequestContext` so a flooding address is turned away
  // before the session lookup, and ahead of the 405 so unsupported methods are
  // counted rather than routing freely. The route ceiling waits for a caller.
  const address = checkAddressRateLimit(caller);
  if (address && !address.allowed) {
    logRateLimit(pathname, method, address);
    return rateLimitedResponse(address);
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
    // One identity cache for the length of this request, so the IdP staleness
    // bound stays a per-request bound rather than a per-check one.
    const { limit, result } = await withIdentityScope(async () => {
      await hydrateRequestContext(c);
      // Keyed on the resolved user: a credential the server never accepted
      // must not buy a window of its own.
      const limit = checkRateLimit({
        ...caller,
        pattern: match.pattern,
        method,
        userId: c.var.user?.id,
      });
      if (limit && !limit.allowed) {
        logRateLimit(pathname, method, limit);
        return { limit, result: rateLimitedResponse(limit) };
      }
      return { limit, result: await handler(c) };
    });

    if (!(result instanceof Response)) {
      appLogger.error("API handler returned a non-Response value", { path: pathname });
      return jsonError(500, "Internal server error");
    }

    return limit ? withRateLimitHeaders(result, limit) : result;
  } catch (error) {
    if (error instanceof AclFailure) {
      return aclFailureResponse(error);
    }
    appLogger.error("Unhandled API route error", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(500, "Internal server error");
  }
}
