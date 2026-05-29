import type { APIContext, APIRoute } from "astro";

/**
 * The subset of Astro's `APIContext` that the migrated API route handlers
 * actually consume. The Express adapter constructs an object of this shape so
 * the handlers can run without the Astro runtime.
 */
export type ApiContext = Pick<APIContext, "request" | "params" | "url" | "locals">;

/** HTTP methods (plus Astro's catch-all `ALL`) a route module may export. */
export type ApiRouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "ALL";

/** A migrated route module: a map of uppercase method names to handlers. */
export type ApiRouteModule = Partial<Record<ApiRouteMethod, APIRoute>>;
