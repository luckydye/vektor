import type { APIRoute } from "astro";
import { badRequestResponse, requireUser, withApiErrorHandling } from "#db/api.ts";
import { assertPublicUrl, SsrfError } from "#utils/ssrf.ts";

// Only relay content types that the canvas link-preview card can meaningfully display.
const ALLOWED_CONTENT_TYPE_PREFIXES = ["video/", "audio/"];

const HEADERS_TO_FORWARD = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
];

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    requireUser(context);

    const url = context.url.searchParams.get("url");
    if (!url) throw badRequestResponse("url parameter is required");

    try {
      new URL(url);
    } catch {
      throw badRequestResponse("Invalid URL");
    }

    try {
      await assertPublicUrl(url);
    } catch (error) {
      if (error instanceof SsrfError) throw badRequestResponse(error.message);
      throw error;
    }

    const upstreamHeaders: HeadersInit = {
      "User-Agent": "Mozilla/5.0 (compatible; WikiBot/1.0)",
    };
    const range = context.request.headers.get("range");
    if (range) upstreamHeaders["Range"] = range;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        signal: controller.signal,
        headers: upstreamHeaders,
      });
    } finally {
      clearTimeout(timeout);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => contentType.startsWith(p))) {
      throw badRequestResponse("URL did not return video or audio content");
    }

    const out = new Headers();
    for (const header of HEADERS_TO_FORWARD) {
      const value = upstream.headers.get(header);
      if (value) out.set(header, value);
    }
    out.set("cache-control", "public, max-age=3600, immutable");

    return new Response(upstream.body, { status: upstream.status, headers: out });
  });
