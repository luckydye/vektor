/**
 * Decoded images for every painter, loaded through `sameOriginMediaUrl` so
 * WebGL may upload them.
 */

import { sameOriginMediaUrl } from "#canvas/render/imageSource.ts";

const images = new Map<string, HTMLImageElement | "loading" | "error">();
const waiting = new Map<string, Set<() => void>>();

/** SVG markup as a data URL with an explicit `size` px box, colouring `currentColor`. */
export function sizedSvgUrl(markup: string, size: number, color?: string): string {
  // The HTML parser puts inline icon markup in the SVG namespace even without
  // an xmlns, and the XML serializer then writes it out.
  const source = color ? markup.replace(/currentColor/g, color) : markup;
  const root = new DOMParser().parseFromString(source, "text/html").querySelector("svg");
  if (!root) throw new Error("Markup has no SVG");
  root.setAttribute("width", String(size));
  root.setAttribute("height", String(size));
  const svg = new XMLSerializer().serializeToString(root);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// An SVG without width/height has no intrinsic size, and WebGL cannot upload a
// 0×0 image, so it is re-decoded with one.
async function decode(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (image.naturalWidth > 0) return image;
  const markup = await (await fetch(url)).text();
  const sized = new Image();
  sized.src = sizedSvgUrl(markup, 512);
  await sized.decode();
  return sized;
}

/** Images still decoding, so an export can wait for them. */
export function pendingImageLoads(): number {
  let pending = 0;
  for (const state of images.values()) if (state === "loading") pending++;
  return pending;
}

/** The decoded image if it has already loaded, without starting a load. */
export function cachedImage(src: string): HTMLImageElement | null {
  const cached = images.get(src);
  return cached instanceof HTMLImageElement ? cached : null;
}

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
  const settle = (state: HTMLImageElement | "error") => {
    images.set(src, state);
    for (const repaint of waiting.get(src) ?? []) repaint();
    waiting.delete(src);
  };
  decode(sameOriginMediaUrl(src)).then(settle, () => settle("error"));
  return null;
}
