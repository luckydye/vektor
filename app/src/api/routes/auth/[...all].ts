import type { ApiRouteHandler } from "#api/server/types.ts";
import { auth } from "#auth";

export const ALL: ApiRouteHandler = async (ctx) => {
  // Keep better-auth's rate-limit identity pinned to the trusted client IP.
  return auth.handler(new Request(ctx.req.raw, { headers: ctx.var.requestHeaders }));
};
