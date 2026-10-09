/**
 * Decoded images for painters that show pictures beside other content (link
 * previews, favicons, document images), loaded through `sameOriginMediaUrl`.
 */

import { sameOriginMediaUrl } from "#canvas/render/imageSource.ts";

const images = new Map<string, HTMLImageElement | "loading" | "error">();
const waiting = new Map<string, Set<() => void>>();

/** The decoded image, or null while it loads or after it failed. */
export function loadedImage(
  src: string,
  invalidate: () => void,
): HTMLImageElement | null {
  const cached = images.get(src);
  if (cached instanceof HTMLImageElement) return cached;
  if (cached === "error") return null;
  const listeners = waiting.get(src) ?? new Set();
  waiting.set(src, listeners);
  listeners.add(invalidate);
  if (cached === "loading") return null;
  images.set(src, "loading");
  const image = new Image();
  image.src = sameOriginMediaUrl(src);
  const settle = (state: HTMLImageElement | "error") => {
    images.set(src, state);
    for (const repaint of waiting.get(src) ?? []) repaint();
    waiting.delete(src);
  };
  image.decode().then(
    () => settle(image),
    () => settle("error"),
  );
  return null;
}
