/**
 * SVG icon markup rasterized by the browser through a data-URL `<img>`, at the
 * pixel size it is drawn at (in power-of-two steps), for painting as a texture.
 */

import { loadedImage } from "#canvas/render/images.ts";

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
    // The HTML parser puts inline icon markup in the SVG namespace even without
    // an xmlns, and the XML serializer then writes it out.
    const root = new DOMParser()
      .parseFromString(markup.replace(/currentColor/g, color), "text/html")
      .querySelector("svg");
    if (!root) throw new Error("Icon markup has no SVG");
    root.setAttribute("width", String(size));
    root.setAttribute("height", String(size));
    const svg = new XMLSerializer().serializeToString(root);
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    urls.set(key, url);
  }
  return loadedImage(url, invalidate);
}
