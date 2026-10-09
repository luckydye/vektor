/**
 * SVG icon markup rasterized by the browser through a data-URL `<img>`, at the
 * pixel size it is drawn at (in power-of-two steps), for painting as a texture.
 */

import { loadedImage, sizedSvgUrl } from "#canvas/render/images.ts";

const urls = new Map<string, string>();

/** `markup` with `currentColor` set to `color`, decoded at `pixels`, or null while it decodes. */
export function svgImage(
  markup: string,
  color: string,
  pixels: number,
  invalidate: () => void,
): HTMLImageElement | null {
  const size = 2 ** Math.ceil(Math.log2(Math.max(8, pixels)));
  const key = `${size}|${color}|${markup}`;
  let url = urls.get(key);
  if (!url) {
    url = sizedSvgUrl(markup, size, color);
    urls.set(key, url);
  }
  return loadedImage(url, invalidate);
}
