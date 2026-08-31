import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * The schema never changes within a process, so it is computed once and every
 * request after the first is a string copy — never a per-request rebuild.
 *
 * `generated/openapi.ts` is always expected to exist by the time a request
 * lands here: `scripts/generate-openapi.ts` produces it, run ahead of time by
 * `task compile` for a compiled instance and again at every dev-server start
 * (see `server.ts`) — never lazily from inside a request handler.
 */
let cachedBody: Promise<string> | undefined;

function openApiJson(): Promise<string> {
  cachedBody ??= import("#generated/openapi.ts").then(
    ({ embeddedOpenApiSchema }) => `${JSON.stringify(embeddedOpenApiSchema, null, 2)}\n`,
  );
  return cachedBody;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

/**
 * This OpenAPI document.
 *
 * Generated from the route registry and the doc comment above each handler.
 * Public, like `/.well-known/vektor`: a client reads it to learn what this
 * server speaks before it has credentials to speak with, and it describes
 * routes rather than data.
 *
 * @tag Discovery
 * @public
 */
export const GET: ApiRouteHandler = async () => {
  const body = await openApiJson();
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "public, max-age=3600",
      "Content-Length": Buffer.byteLength(body).toString(),
      "Content-Type": "application/json",
    },
  });
};

/**
 * CORS preflight for the OpenAPI document.
 *
 * @tag Discovery
 */
export const OPTIONS: ApiRouteHandler = () =>
  new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
  });
