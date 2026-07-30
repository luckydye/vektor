import type { CanvasPoint } from "./geometry.ts";

/**
 * Bounding-box arithmetic and the placement of on-screen transform handles.
 *
 * Extracted from `Canvas.vue` on the way to a framework-free canvas host (plan
 * section 6). Everything here takes what it needs as arguments — the viewport
 * scale, a world-to-screen projection — rather than reading it from a ref, so
 * it works identically inside a Vue component, a custom element, or a test.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** Text shapes scale by font size rather than box size; these bound that. */
export const MIN_FONT_SCALE = 0.3;
export const MAX_FONT_SCALE = 10;

export function clampFontScale(value: number): number {
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

/** A finite number, or the fallback. Guards values coming out of Yjs. */
export function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The axis-aligned box around a freehand stroke, or null if it has no points. */
export function strokeBounds(points: readonly CanvasPoint[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The union of several boxes, or null when there are none. */
export function unionBounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Handles keep a fixed size on screen, so their offset from the shape shrinks
 * as the viewport zooms in. These convert that screen-space gap back to world
 * units before projecting, which is why the scale has to be passed in.
 */
export interface HandlePlacement {
  rotation: CanvasPoint;
  resize: CanvasPoint;
}

const ROTATION_GAP_PX = 24;
const RESIZE_GAP_PX = 18;

export function handleOffsets(scale: number): { rotation: number; resize: number } {
  return {
    rotation: ROTATION_GAP_PX / scale,
    resize: RESIZE_GAP_PX / scale / Math.SQRT2,
  };
}

/** Handle positions for an axis-aligned box — strokes and multi-selections. */
export function axisAlignedHandles(
  bounds: Rect,
  scale: number,
  worldToScreen: (point: CanvasPoint) => CanvasPoint,
): HandlePlacement {
  const offset = handleOffsets(scale);
  return {
    rotation: worldToScreen({
      x: bounds.x + bounds.width / 2,
      y: bounds.y - offset.rotation,
    }),
    resize: worldToScreen({
      x: bounds.x + bounds.width + offset.resize,
      y: bounds.y + bounds.height + offset.resize,
    }),
  };
}

/** The scale handle alone, for a multi-selection box that does not rotate. */
export function scaleHandle(
  bounds: Rect,
  scale: number,
  worldToScreen: (point: CanvasPoint) => CanvasPoint,
): CanvasPoint {
  const offset = handleOffsets(scale);
  return worldToScreen({
    x: bounds.x + bounds.width + offset.resize,
    y: bounds.y + bounds.height + offset.resize,
  });
}
