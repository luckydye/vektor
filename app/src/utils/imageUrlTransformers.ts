// Attempt to transform a pasted URL into a direct image fetch URL.
// Returns null if no transformer matches.
export function transformImageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (url.hostname === "unsplash.com" && /^\/photos\/[\w-]+/.test(url.pathname)) {
    const id = url.pathname.split("/")[2];
    return `https://unsplash.com/photos/${id}/download?force=true`;
  }
  if (url.hostname === "images.unsplash.com") return url.href;
  if (
    (url.hostname === "imgur.com" || url.hostname === "www.imgur.com") &&
    /^\/(?!a\/|gallery\/)[\w]+$/.test(url.pathname)
  ) {
    return `https://i.imgur.com/${url.pathname.slice(1)}.jpg`;
  }
  if (url.hostname === "i.imgur.com") return url.href;
  if (
    (url.hostname === "www.pexels.com" || url.hostname === "pexels.com") &&
    url.pathname.startsWith("/photo/")
  ) {
    const match = url.pathname.match(/(\d+)\/?$/);
    if (!match) return url.href;
    return `https://images.pexels.com/photos/${match[1]}/pexels-photo-${match[1]}.jpeg?auto=compress&cs=tinysrgb&w=1260`;
  }
  if (url.hostname === "i.redd.it") return url.href;
  if (url.hostname === "preview.redd.it") {
    const slug = url.pathname.split("/").filter(Boolean)[0] || "";
    const idWithExt = slug.split("-").pop() || slug;
    return `https://i.redd.it/${idWithExt}`;
  }
  if (url.hostname === "upload.wikimedia.org" || url.hostname === "commons.wikimedia.org")
    return url.href;
  if (url.hostname === "pbs.twimg.com") return url.href;
  if (url.hostname.endsWith("staticflickr.com")) return url.href;
  if (url.hostname.endsWith("cdninstagram.com")) return url.href;
  // Direct image URL by extension — catch-all, must be last
  if (/\.(jpe?g|png|webp|tiff?|avif|heic|bmp|gif)(\?.*)?$/i.test(url.pathname))
    return url.href;

  return null;
}

import { withTransformParams } from "../files/transformUrl.ts";

// Must be a subset of ALLOWED_DIMENSIONS in files/transforms.ts.
export const IMAGE_RESIZE_TIERS = [320, 1280] as const;

// Returns a URL for the smallest server-side resize tier that covers targetPx.
// Only affects local upload URLs (/api/v1/spaces/…); everything else is
// returned unchanged because only local uploads go through the resize pipeline.
export function resizeImageUrl(url: string, targetPx: number): string {
  let tier = 0;
  for (const t of IMAGE_RESIZE_TIERS) {
    if (targetPx <= t) {
      tier = t;
      break;
    }
  }
  // targetPx exceeds the largest preset — serve the full-resolution original.
  if (tier === 0) return url;
  return withTransformParams(url, { w: tier });
}

// Extract a reasonable filename from a URL.
export function filenameFromUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "pasted-image.jpg";
  }
  const lastSegment = url.pathname.split("/").pop() || "";
  const decoded = decodeURIComponent(lastSegment);
  if (/\.(jpe?g|png|webp|tiff?|avif|heic|bmp|gif)$/i.test(decoded)) return decoded;
  const format = url.searchParams.get("format");
  const ext =
    format && /^(jpe?g|png|webp|tiff?|avif|gif)$/i.test(format)
      ? format.replace("jpeg", "jpg")
      : "jpg";
  const ts = new Date().toISOString().replace(/T/, "-").replace(/:/g, "-").replace(/\.\d+Z$/, "");
  return `url-image-${ts}.${ext}`;
}
