import type { ApiRouteHandler } from "#api/server/types.ts";

function corsJson(data: unknown): Response {
  const body = JSON.stringify(data);
  return new Response(body, {
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
      "Content-Length": Buffer.byteLength(body).toString(),
      "Content-Type": "application/json",
    },
  });
}

/**
 * Instance discovery document
 *
 * Identifies the server as a Vektor instance and names the API version it speaks.
 *
 * @tag Discovery
 * @public
 * @response #/components/schemas/InstanceInfo
 */
export const GET: ApiRouteHandler = () =>
  corsJson({
    service: "vektor",
    version: 1,
    apiVersion: "v1",
    documentEndpoint: "/api/v1/spaces/{spaceId}/documents/{documentId}",
    // Where the rest of the API describes itself, so a client discovers the
    // whole surface from this one unauthenticated document.
    openapiEndpoint: "/api/v1/openapi.json",
  });

/**
 * CORS preflight for the discovery document
 *
 * @tag Discovery
 * @public
 */
export const OPTIONS: ApiRouteHandler = () =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
