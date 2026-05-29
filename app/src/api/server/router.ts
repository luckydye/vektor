import type { NextFunction, Request as ExRequest, Response as ExResponse } from "express";
import { appLogger } from "#observability/logger.ts";
import { apiRoutes } from "../routes.ts";
import { buildApiContext, sendWebResponse } from "./adapter.ts";
import { compileRoute, matchRoute, sortRoutes, type CompiledRoute } from "./matcher.ts";
import type { ApiRouteMethod, ApiRouteModule } from "./types.ts";

const compiledRoutes: CompiledRoute[] = sortRoutes(
  apiRoutes.map(({ pattern, module }) => compileRoute(pattern, module)),
);

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

  const handler = resolveHandler(match.module, (req.method ?? "GET").toUpperCase());
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
