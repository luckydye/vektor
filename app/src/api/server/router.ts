import type { Request as ExRequest, Response as ExResponse, NextFunction } from "express";
import { authTrustedOrigins } from "#auth";
import { appLogger } from "#observability/logger.ts";
import { apiRoutes } from "../routes.ts";
import { buildApiContext, PayloadTooLargeError, sendWebResponse } from "./adapter.ts";
import { type CompiledRoute, compileRoute, matchRoute, sortRoutes } from "./matcher.ts";
import type { ApiRouteMethod, ApiRouteModule } from "./types.ts";

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
function isCrossSiteForgery(req: ExRequest, method: string): boolean {
  if (SAFE_METHODS.has(method)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  if (trustedOrigins.has(origin)) return false;
  // Same-origin fallback for deployments without WIKI_SITE_URL: the browser
  // sets Host to the target server, so Origin host === Host implies the
  // request came from a page served by this very host.
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function isApiPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/.well-known/caldav"
  );
}

function resolveHandler(module: ApiRouteModule, method: string) {
  const handler = module[method as ApiRouteMethod] ?? module.ALL;
  return handler;
}

function jsonError(res: ExResponse, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * Express middleware that serves the migrated API routes. Non-API paths fall
 * through to the next handler (e.g. the Astro frontend handler, when mounted).
 */
export async function apiRouter(
  req: ExRequest,
  res: ExResponse,
  next: NextFunction,
): Promise<void> {
  const pathname = req.path;
  if (!isApiPath(pathname)) {
    next();
    return;
  }

  const match = matchRoute(compiledRoutes, pathname);
  if (!match) {
    jsonError(res, 404, "Not found");
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (isCrossSiteForgery(req, method)) {
    jsonError(res, 403, "Cross-origin request rejected");
    return;
  }

  const handler = resolveHandler(match.module, method);
  if (!handler) {
    const allowed = Object.keys(match.module)
      .filter((key) => key !== "ALL")
      .join(", ");
    res.setHeader("Allow", allowed);
    jsonError(res, 405, "Method not allowed");
    return;
  }

  try {
    const context = await buildApiContext(req, match.params);
    const result = await handler(context as never);

    if (!(result instanceof Response)) {
      appLogger.error("API handler returned a non-Response value", { path: pathname });
      jsonError(res, 500, "Internal server error");
      return;
    }

    await sendWebResponse(res, result);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      if (!res.headersSent) jsonError(res, 413, "Request body too large");
      else res.end();
      return;
    }
    appLogger.error("Unhandled API route error", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      jsonError(res, 500, "Internal server error");
    } else {
      res.end();
    }
  }
}
