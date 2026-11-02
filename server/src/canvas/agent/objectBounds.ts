/**
 * World bounds of stored objects, as the server computes them: the rotated
 * frame, connector routes through their endpoints, stroke point bounds. Text
 * is not laid out, so a text overflowing its frame keeps the client's bbox.
 */

import { shapeBounds } from "#canvas/agent/model.ts";
import {
  type CanvasObject,
  EXTENSION_STATE_TYPE,
  objectRefs,
  objectToItem,
  objectType,
  STROKE_TYPE,
} from "#canvas/document/format/object.ts";
import { readProperty } from "#canvas/document/format/properties.ts";
import { type BBox, decodePoints } from "#canvas/document/format/records.ts";
import type { SceneShape } from "#canvas/raster/scene.ts";
import { FREEHAND_STYLE, maxStrokeWidth } from "#canvas/render/freehand.ts";

const DEFAULT_SIZES: Record<string, { width: number; height: number }> = {
  note: { width: 180, height: 120 },
  section: { width: 560, height: 340 },
  geo: { width: 200, height: 120 },
  text: { width: 1, height: 1 },
};

export function sceneShapeOf(object: CanvasObject): SceneShape {
  const { item } = objectToItem(object, undefined);
  const frame = item.frame as Record<string, number | undefined>;
  const fallback = DEFAULT_SIZES[item.type as string] ?? { width: 320, height: 200 };
  return {
    id: object.id,
    type: item.type as string,
    frame: {
      x: frame.x ?? 0,
      y: frame.y ?? 0,
      width: frame.width ?? fallback.width,
      height: frame.height ?? fallback.height,
      rotation: frame.rotation ?? 0,
    },
    style: { color: String((item.style as { color?: unknown }).color ?? "transparent") },
    data: item.data as Record<string, unknown>,
    z: Number(item.z ?? 0),
  };
}

/**
 * The object's bounds, or null for a stroke without points and for the
 * extensions' state, which has no place on the canvas. `lookup` resolves
 * the objects its `refs` name, as rendering does.
 */
export function objectBounds(
  object: CanvasObject,
  lookup: (id: string) => CanvasObject | undefined,
): BBox | null {
  if (objectType(object) === EXTENSION_STATE_TYPE) return null;
  if (objectType(object) === STROKE_TYPE) {
    const points = readProperty(object.properties, "points");
    const decoded = points instanceof Uint8Array ? decodePoints(points) : [];
    if (decoded.length === 0) return null;
    const width = readProperty(object.properties, "style.width");
    let reach =
      maxStrokeWidth({
        ...FREEHAND_STYLE,
        width: typeof width === "number" ? width : FREEHAND_STYLE.width,
      }) / 2;
    const box: BBox = [decoded[0].x, decoded[0].y, decoded[0].x, decoded[0].y];
    for (const point of decoded) {
      box[0] = Math.min(box[0], point.x);
      box[1] = Math.min(box[1], point.y);
      box[2] = Math.max(box[2], point.x);
      box[3] = Math.max(box[3], point.y);
      reach = Math.max(reach, point.width / 2);
    }
    return [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach];
  }
  const route = drawnBounds(object, lookup);
  // A connector's box spans its endpoints too, so moving one never leaves it outside.
  return objectRefs(object).reduce<BBox>((box, id) => {
    const target = lookup(id);
    return target && objectType(target) !== STROKE_TYPE
      ? (unionBBox(box, drawnBounds(target, lookup)) as BBox)
      : box;
  }, route);
}

function drawnBounds(
  object: CanvasObject,
  lookup: (id: string) => CanvasObject | undefined,
): BBox {
  const rect = shapeBounds(sceneShapeOf(object), (id) => {
    const target = lookup(id);
    return target ? sceneShapeOf(target) : undefined;
  });
  return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
}

export function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
