/**
 * Strokes as snapshot items: the plain shape objects flatten to and from (see
 * `#canvas/document/format/object.ts`), where their points pack into bytes.
 */
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

export function strokeToItem(stroke: CanvasStrokeSnapshot): Record<string, unknown> {
  return {
    id: stroke.id,
    points: stroke.points.map(cloneFreehandPoint),
    style: { ...stroke.style },
    ...(stroke.kind === "shape" ? { kind: "shape" } : {}),
    ...(typeof stroke.rotation === "number" ? { rotation: stroke.rotation } : {}),
    ...(stroke.authorId ? { authorId: stroke.authorId } : {}),
    ...(stroke.locked ? { locked: true } : {}),
    updatedAt: stroke.updatedAt,
    // Strokes stack by their last edit.
    z: stroke.updatedAt,
  };
}

export function toCanvasStroke(
  id: string,
  source: CanvasStrokeSnapshot | Record<string, unknown>,
): CanvasStroke {
  const read = (key: keyof CanvasStrokeSnapshot) =>
    (source as Record<string, unknown>)[key];
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
