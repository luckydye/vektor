import type { APIRoute } from "astro";

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

export const GET: APIRoute = () =>
  corsJson({
    service: "vektor",
    version: 1,
    apiVersion: "v1",
    documentEndpoint: "/api/v1/spaces/{spaceId}/documents/{documentId}",
  });

export const OPTIONS: APIRoute = () =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
