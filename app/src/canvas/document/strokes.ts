/**
 * Strokes on the wire: Y.Map <-> CanvasStroke.
 *
 * Freehand points are stored as plain objects rather than nested Y types — a
 * stroke is written once and never edited point-by-point, so per-point CRDT
 * granularity would cost memory and buy nothing.
 */
import * as Y from "yjs";
import {
  buildFreehandStroke,
  createFreehandOptions,
  FREEHAND_STYLE,
  type FreehandPoint,
  type FreehandStrokeStyle,
} from "#canvas/render/freehand.ts";
import type { CanvasStroke, CanvasStrokeSnapshot } from "#canvas/runtime/extensionApi.ts";

function isFreehandPoint(value: unknown): value is FreehandPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FreehandPoint).x === "number" &&
    typeof (value as FreehandPoint).y === "number"
  );
}

export function cloneFreehandPoint(point: FreehandPoint): FreehandPoint {
  return {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
    time: point.time,
    velocity: point.velocity,
    width: point.width,
  };
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
  worldToScreenScale = 1,
): CanvasStroke {
  const read = (key: keyof CanvasStrokeSnapshot) =>
    source instanceof Y.Map ? source.get(key) : source[key];
  const pointsValue = read("points");
  const points = Array.isArray(pointsValue)
    ? pointsValue.filter(isFreehandPoint).map(cloneFreehandPoint)
    : [];
  const style = strokeStyleFromUnknown(read("style"));
  const authorId = read("authorId");

  // Persisted points already carry the widths computed while drawing.
  // Recomputing velocity widths here would depend on the viewer's current zoom
  // and on the pre-layout 1x1 screen during initial load, so only derive widths
  // when none were stored.
  const options = createFreehandOptions(style, worldToScreenScale);
  if (points.some((point) => point.width !== undefined)) {
    options.velocityWidth = undefined;
  }
  const stroke = buildFreehandStroke(points, options);
  return {
    id,
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
    ...stroke,
  };
}
