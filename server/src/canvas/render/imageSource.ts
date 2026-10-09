/**
 * WebGL only uploads same-origin pixels, so anything else is fetched through
 * the server's media proxy, which relays raster images, video and audio.
 */
export function sameOriginMediaUrl(src: string): string {
  const url = new URL(src, window.location.href);
  if (
    url.origin === window.location.origin ||
    url.protocol === "data:" ||
    url.protocol === "blob:"
  ) {
    return url.href;
  }
  return `/api/v1/proxy-media?url=${encodeURIComponent(url.href)}`;
}
