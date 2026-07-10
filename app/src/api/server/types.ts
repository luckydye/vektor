import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "hono";

export type ApiBindings = {
  Bindings: {
    incoming: IncomingMessage;
    outgoing: ServerResponse;
  };
  Variables: {
    params: Record<string, string | undefined>;
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
