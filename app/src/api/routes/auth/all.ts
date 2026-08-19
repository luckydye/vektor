import type { ApiRouteHandler } from "#api/server/types.ts";
import { auth } from "#auth";

export const ALL: ApiRouteHandler = async (ctx) => {
  const { raw } = ctx.req;
  // Rebuild the request so better-auth's rate-limit identity stays pinned to the
  // trusted client IP (carried in requestHeaders) while preserving the original
  // method and streaming body. `new Request(raw, { headers })` drops the body on
  // POSTs under Bun's node-http bridge, which hangs better-auth forever.
  return auth.handler(
    new Request(raw.url, {
      method: raw.method,
      headers: ctx.var.requestHeaders,
      body: raw.body,
      duplex: "half",
      redirect: raw.redirect,
      signal: raw.signal,
    } as RequestInit & { duplex: "half" }),
  );
};
