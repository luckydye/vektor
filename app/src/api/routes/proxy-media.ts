import { badRequestResponse, requireUser, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { appLogger } from "#observability/logger.ts";
import { SsrfError, safeFetch } from "#utils/ssrf.ts";

// Only relay content types that the canvas link-preview card can meaningfully display.
const ALLOWED_CONTENT_TYPE_PREFIXES = ["video/", "audio/"];

const HEADERS_TO_FORWARD = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
];

/**
 * One rejection message for every reason a URL is not proxyable.
 *
 * "URL host is not allowed" and "URL did not return video or audio content" used
 * to be distinguishable, which made the endpoint a reliable host/port scanner:
 * the pair of answers tells the caller whether a target was reachable. The
 * specific reason goes to the server log instead, so operators keep the detail
 * that is actually useful for debugging.
 */
const REJECTED_MESSAGE = "URL cannot be proxied as media";

/**
 * Origin and path only. A media URL routinely carries a signature or a token in
 * its query, and userinfo in its authority, none of which belongs in a log the
 * caller can fill at will.
 */
function redactForLog(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

function rejectMedia(url: string, reason: string): Response {
  appLogger.warn("proxy-media refused a URL", { url: redactForLog(url), reason });
  return badRequestResponse(REJECTED_MESSAGE);
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    requireUser(context);

    const url = new URL(context.req.url).searchParams.get("url");
    if (!url) throw badRequestResponse("url parameter is required");

    try {
      new URL(url);
    } catch {
      throw badRequestResponse("Invalid URL");
    }

    const upstreamHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (compatible; VektorBot/1.0)",
    };
    const range = context.req.raw.headers.get("range");
    if (range) upstreamHeaders.Range = range;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let upstream: Response;
    try {
      // `safeFetch`, never a bare `fetch`: it validates and pins every redirect
      // hop, so a public URL cannot 302 the server into loopback, the private
      // network or the cloud metadata endpoint.
      upstream = await safeFetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: upstreamHeaders,
      });
    } catch (error) {
      if (error instanceof SsrfError) throw rejectMedia(url, error.message);
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => contentType.startsWith(p))) {
      throw rejectMedia(url, `content-type "${contentType}" is not audio or video`);
    }

    const out = new Headers();
    for (const header of HEADERS_TO_FORWARD) {
      const value = upstream.headers.get(header);
      if (value) out.set(header, value);
    }
    out.set("cache-control", "public, max-age=3600, immutable");

    return new Response(upstream.body, { status: upstream.status, headers: out });
  });
