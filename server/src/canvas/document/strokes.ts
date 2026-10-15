/**
 * Strokes on the wire: Y.Map <-> CanvasStroke.
 *
 * Freehand points are stored as plain objects rather than nested Y types — a
 * stroke is written once and never edited point-by-point, so per-point CRDT
 * granularity would cost memory and buy nothing.
 */
import * as Y from "yjs";
import {
  FREEHAND_STYLE,
  type FreehandPoint,
  type FreehandStrokeStyle,
} from "#canvas/render/freehand.ts";
import type { CanvasStroke, CanvasStrokeSnapshot } from "#canvas/runtime/extensionApi.ts";

function isStoredPoint(value: unknown): value is Omit<FreehandPoint, "width"> & {
  width?: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FreehandPoint).x === "number" &&
    typeof (value as FreehandPoint).y === "number"
  );
}

export function cloneFreehandPoint(point: FreehandPoint): FreehandPoint {
  return { x: point.x, y: point.y, width: point.width };
}

export function strokeStyleFromUnknown(value: unknown): FreehandStrokeStyle {
  return typeof value === "object" && value !== null
    ? { ...FREEHAND_STYLE, ...(value as Partial<FreehandStrokeStyle>) }
    : { ...FREEHAND_STYLE };
}

export function createStrokeMap(stroke: CanvasStrokeSnapshot) {
  const map = new Y.Map<unknown>();
  map.set("points", stroke.points.map(cloneFreehandPoint));
  map.set("style", { ...stroke.style });
  if (stroke.kind === "shape") map.set("kind", "shape");
  if (typeof stroke.rotation === "number") map.set("rotation", stroke.rotation);
  if (stroke.authorId) map.set("authorId", stroke.authorId);
  if (stroke.locked) map.set("locked", true);
  map.set("updatedAt", stroke.updatedAt);
  return map;
}

export function toCanvasStroke(
  id: string,
  source: Y.Map<unknown> | CanvasStrokeSnapshot,
): CanvasStroke {
  const read = (key: keyof CanvasStrokeSnapshot) =>
    source instanceof Y.Map ? source.get(key) : source[key];
  const pointsValue = read("points");
  const style = strokeStyleFromUnknown(read("style"));
  const points = Array.isArray(pointsValue)
    ? pointsValue.filter(isStoredPoint).map((point) => ({
        x: point.x,
        y: point.y,
        // @deprecated Stamped shapes used to store points without a width.
        width: point.width ?? style.width,
      }))
    : [];
  const authorId = read("authorId");
  return {
    id,
    points,
    style,
    kind: read("kind") === "shape" ? "shape" : undefined,
    rotation:
      typeof read("rotation") === "number" && Number.isFinite(read("rotation"))
        ? Number(read("rotation"))
        : undefined,
    authorId: typeof authorId === "string" ? authorId : undefined,
    locked: read("locked") === true || undefined,
    updatedAt:
      typeof read("updatedAt") === "number" && Number.isFinite(read("updatedAt"))
        ? Number(read("updatedAt"))
        : Date.now(),
  };
}
