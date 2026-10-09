/**
 * The bundled faces canvas text is drawn with, loaded on first use. They are
 * the same Inter the DOM uses, so text wraps alike when a live editor takes
 * over from the painted copy.
 */

import { type Font, parseFont } from "#canvas/render/font.ts";

export type FontFace = "regular" | "italic" | "semibold" | "bold" | "boldItalic" | "mono";

const FONT_URLS: Record<FontFace, () => Promise<{ default: string }>> = {
  regular: () => import("#assets/fonts/Inter-Regular.ttf?url"),
  italic: () => import("#assets/fonts/Inter-Italic.ttf?url"),
  semibold: () => import("#assets/fonts/Inter-SemiBold.ttf?url"),
  bold: () => import("#assets/fonts/Inter-Bold.ttf?url"),
  boldItalic: () => import("#assets/fonts/Inter-BoldItalic.ttf?url"),
  mono: () => import("#assets/fonts/JetBrainsMono-Regular.ttf?url"),
};

const loaded = new Map<FontFace, Font>();
const loading = new Map<FontFace, Promise<void>>();
const waiting = new Set<() => void>();

function load(face: FontFace) {
  const pending = FONT_URLS[face]()
    .then((module) => fetch(module.default))
    .then((response) => {
      if (!response.ok) throw new Error(`Canvas font ${face} failed: ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      loaded.set(face, parseFont(buffer));
      if (loading.size !== loaded.size) return;
      for (const repaint of waiting) repaint();
      waiting.clear();
    });
  loading.set(face, pending);
}

/**
 * Every face asked for, or null while any is still loading; `invalidate` runs
 * once all requested faces have arrived.
 */
export function fontFaces(
  faces: Iterable<FontFace>,
  invalidate: () => void,
): ReadonlyMap<FontFace, Font> | null {
  let ready = true;
  for (const face of faces) {
    if (loaded.has(face)) continue;
    ready = false;
    if (!loading.has(face)) load(face);
  }
  if (ready) return loaded;
  waiting.add(invalidate);
  return null;
}
