import type { Context } from "hono";
import type { CallerCredentials } from "#acl/guards.ts";
import type { Platform } from "#platform/platform.ts";

export type ApiBindings = {
  Bindings: {
    /** The connection's peer address, which the entry point reads from its transport. */
    clientAddress: string | null;
  };
  Variables: {
    /** What a guard may authenticate this request with; see `hydrateRequestContext`. */
    credentials: CallerCredentials;
    params: Record<string, string | undefined>;
    /** The target this server runs on, set once by the app factory. */
    platform: Platform;
    publicEnv: App.Locals["publicEnv"];
    requestHeaders: Headers;
    session: App.Locals["session"];
    user: App.Locals["user"];
  };
};

/** A Hono context enriched with the authenticated request state. */
export type ApiContext = Context<ApiBindings>;

/** A Hono-native handler for one API route method. */
export type ApiRouteHandler = (context: ApiContext) => Response | Promise<Response>;

/** HTTP methods (plus the catch-all `ALL`) a route module may export. */
export type ApiRouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "ALL";

/** A migrated route module: a map of uppercase method names to handlers. */
export type ApiRouteModule = Partial<Record<ApiRouteMethod, ApiRouteHandler>>;
