/**
 * A stored canvas snapshot as the agent tools see it: shapes with complete
 * frames (text measured, lines resolved), and which frame holds what, so
 * coordinates can be given relative to a slide.
 */

import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import { lineStyle, resolveLine } from "#canvas/render/shapeGeometry.ts";
import { polygonBounds } from "#canvas/render/vector.ts";
import { rotatedShapeBounds } from "#canvas/runtime/geometry.ts";
import { measureTextShape, type SceneShape, type SceneStroke } from "#canvas/raster/scene.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a stored shape looks like in the snapshot JSON. */
export interface StoredShape {
  id: string;
  type: string;
  frame: { x: number; y: number; width?: number; height?: number; rotation: number };
  style: { color: string };
  data: Record<string, unknown>;
  updatedAt: number;
  z?: number;
  authorId?: string;
  locked?: boolean;
}

export interface StoredSnapshot {
  version: 1;
  shapes: StoredShape[];
  strokes: Record<string, unknown>[];
}

const DEFAULT_SIZES: Record<string, { width: number; height: number }> = {
  note: { width: 180, height: 120 },
  section: { width: 560, height: 340 },
  geo: { width: 200, height: 120 },
};

export function parseSnapshot(content: string): StoredSnapshot {
  const parsed = content.trim() ? (JSON.parse(content) as Partial<StoredSnapshot>) : {};
  return {
    version: 1,
    shapes: Array.isArray(parsed.shapes) ? parsed.shapes : [],
    strokes: Array.isArray(parsed.strokes) ? parsed.strokes : [],
  };
}

/** Every shape with a full frame; text sizes itself from its content. */
export function sceneShapes(
  snapshot: StoredSnapshot,
  faces: ReadonlyMap<FontFace, Font>,
): SceneShape[] {
  return snapshot.shapes.map((shape) => {
    const fallback = DEFAULT_SIZES[shape.type] ?? { width: 320, height: 200 };
    const size =
      shape.type === "text"
        ? measureTextShape(shape.data, faces)
        : {
            width: shape.frame.width ?? fallback.width,
            height: shape.frame.height ?? fallback.height,
          };
    return {
      id: shape.id,
      type: shape.type,
      frame: { x: shape.frame.x, y: shape.frame.y, rotation: shape.frame.rotation ?? 0, ...size },
      style: { color: shape.style?.color ?? "transparent" },
      data: shape.data ?? {},
      // @deprecated Shapes stored before `z` existed stack by their last edit.
      z: shape.z ?? shape.updatedAt ?? 0,
    };
  });
}

export function sceneStrokes(snapshot: StoredSnapshot): SceneStroke[] {
  return snapshot.strokes.flatMap((stroke) => {
    const points = Array.isArray(stroke.points) ? (stroke.points as SceneStroke["points"]) : [];
    const style = (stroke.style ?? {}) as { color?: string; width?: number };
    return points.length > 0
      ? [{ points, color: style.color ?? "#111827", width: style.width ?? 4 }]
      : [];
  });
}

/** World bounds of a shape as drawn, rotation and line routes included. */
export function shapeBounds(
  shape: SceneShape,
  lookup: (id: string) => SceneShape | undefined,
): Rect {
  if (shape.type === "line") {
    const { points } = resolveLine(shape.data, lookup, 0.5);
    const bounds = polygonBounds([points]);
    const pad = lineStyle(shape.data).width;
    return { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 };
  }
  return rotatedShapeBounds(shape.frame);
}

export function contains(outer: Rect, inner: Rect, slack = 0.5) {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

export function overlap(a: Rect, b: Rect) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The frame (section) each shape sits in: the smallest one wholly containing
 * it. A frame can sit in a bigger frame.
 */
export function parentFrames(shapes: readonly SceneShape[]): Map<string, string> {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const lookup = (id: string) => byId.get(id);
  const frames = shapes
    .filter((shape) => shape.type === "section")
    .map((shape) => ({ id: shape.id, bounds: shapeBounds(shape, lookup) }))
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  const parents = new Map<string, string>();
  for (const shape of shapes) {
    const bounds = shapeBounds(shape, lookup);
    const frame = frames.find((candidate) => candidate.id !== shape.id && contains(candidate.bounds, bounds) &&
      // A frame is never its own container's container.
      candidate.bounds.width * candidate.bounds.height > bounds.width * bounds.height);
    if (frame) parents.set(shape.id, frame.id);
  }
  return parents;
}
