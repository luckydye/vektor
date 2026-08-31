import { loadRouteDocs } from "#api/openapi/discover.ts";
import { buildOpenApiDocument } from "#api/openapi/document.ts";
import type { OpenApiDocument } from "#api/openapi/types.ts";
// `#api/routes.ts` imports this module, so importing the registry back is a
// cycle: `apiRoutes` is read inside the handler, by which time both modules
// have finished evaluating.
import { apiRoutes } from "#api/routes.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * The schema never changes within a process, so it is computed once and every
 * request after the first is a string copy — never a per-request rebuild.
 *
 * In a compiled instance it is computed once already, at the actual build
 * (`scripts/generate-openapi.ts`, run by `task compile`): this just reads that
 * frozen JSON back out. In dev and in tests, where the route files this reads
 * doc comments from are on disk and can change between requests, it is instead
 * read live — but still only on the first request each process serves, not
 * on every one.
 */
let cachedDocument: Promise<string> | undefined;

async function buildDocument(): Promise<OpenApiDocument> {
  if (import.meta.env.DEV) {
    return buildOpenApiDocument(apiRoutes, await loadRouteDocs());
  }
  const { embeddedOpenApiSchema } = await import("#generated/openapi.ts");
  return embeddedOpenApiSchema as unknown as OpenApiDocument;
}

function openApiJson(): Promise<string> {
  cachedDocument ??= buildDocument().then(
    (document) => `${JSON.stringify(document, null, 2)}\n`,
  );
  return cachedDocument;
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
