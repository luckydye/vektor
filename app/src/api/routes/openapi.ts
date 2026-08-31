import { buildOpenApiDocument } from "#api/openapi/document.ts";
// `#api/routes.ts` imports this module, so importing the registry back is a
// cycle: `apiRoutes` is read inside the handler, by which time both modules
// have finished evaluating.
import { apiRoutes } from "#api/routes.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * The schema is a function of the compiled-in route registry and nothing else,
 * so it is built once and every request after the first is a string copy.
 */
let cachedDocument: string | undefined;

function openApiJson(): string {
  cachedDocument ??= `${JSON.stringify(buildOpenApiDocument(apiRoutes), null, 2)}\n`;
  return cachedDocument;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

/**
 * The instance's own OpenAPI description. Public, like `/.well-known/vektor`:
 * a client reads it to learn what this server speaks before it has credentials
 * to speak with, and it describes routes rather than data.
 */
export const GET: ApiRouteHandler = () => {
  const body = openApiJson();
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "public, max-age=3600",
      "Content-Length": Buffer.byteLength(body).toString(),
      "Content-Type": "application/json",
    },
  });
};

export const OPTIONS: ApiRouteHandler = () =>
  new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
  });
