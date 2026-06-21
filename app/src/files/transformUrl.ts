const UPLOAD_PATH_PREFIX = "/api/v1/spaces/";

export const TRANSFORMABLE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/**
 * Append transform query params to an internal upload URL.
 * Returns the URL unchanged if it is external, an SVG, or already has a query
 * string (to avoid double-processing).
 *
 * Browser-safe: no Node.js imports.
 */
export function withTransformParams(
  url: string,
  params: { w?: number; format?: "webp" | "jpeg" | "png"; q?: number },
): string {
  let pathname: string;
  try {
    pathname = new URL(url, "http://internal").pathname;
  } catch {
    return url;
  }

  if (!pathname.startsWith(UPLOAD_PATH_PREFIX)) return url;

  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  if (!TRANSFORMABLE_EXTENSIONS.has(ext)) return url;

  if (url.includes("?")) return url;

  const search = new URLSearchParams();
  if (params.w) search.set("w", String(params.w));
  if (params.format) search.set("format", params.format);
  if (params.q) search.set("q", String(params.q));

  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}
