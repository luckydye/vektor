import * as Y from "yjs";
import { canvasPenIcon, pencilIcon } from "../../assets/icons.ts";
import type { TranslationKey } from "../../utils/lang.ts";
import {
  buildFreehandStroke,
  createFreehandStrokeBuilder,
  drawFreehandOutline,
  drawFreehandStroke,
  drawSnapGuides,
  type FreehandPoint,
  type FreehandStroke,
  type FreehandStrokeBuilder,
  type FreehandStrokeOptions,
  type FreehandStrokeStyle,
  type ScreenSize,
  type SnapGuide,
  type WorldTransform,
} from "../../viewport/index.ts";
import type { CanvasStroke, CanvasStrokeSnapshot } from "./types.ts";

export type DrawStrokeMode = "pencil" | "pen";
export type CanvasDrawingSession = {
  pointerId: number;
  builder: FreehandStrokeBuilder;
  mode: DrawStrokeMode;
};

export const FREEHAND_STYLE: FreehandStrokeStyle = {
  color: "#111827",
  width: 10,
  opacity: 1,
  lineCap: "round",
  lineJoin: "round",
};

// Width bounds are in world units; the renderer scales them by zoom. Pen mode
// intentionally has a broad range so velocity and stylus pressure read clearly.
const FREEHAND_PEN_VELOCITY = {
  minWidth: 2,
  maxWidth: 18,
  smoothing: 0.45,
};

// The stroke reaches its thinnest at roughly this pointer speed in screen px/ms.
const SCREEN_VELOCITY_FULL = 2.4;

export const PEN_COLORS = [
  "#111827",
  "#ef4444",
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
] as const;

export const DRAW_STROKE_MODES: Array<{
  id: DrawStrokeMode;
  label: TranslationKey;
  icon: string;
}> = [
  {
    id: "pencil",
    label: "Pencil",
    icon: pencilIcon,
  },
  {
    id: "pen",
    label: "Pen",
    icon: canvasPenIcon,
  },
];

// addVelocityWidths measures velocity in world units/ms, so it would otherwise
// taper differently depending on zoom. Multiplying the scale by the current
// world->screen scale makes the taper track on-screen pointer speed instead.
export function createFreehandOptions(
  style: FreehandStrokeStyle = FREEHAND_STYLE,
  mode: DrawStrokeMode = "pen",
  worldToScreenScale = 1,
): FreehandStrokeOptions {
  return {
    minDistance: 2,
    simplifyTolerance: 0.75,
    smoothing: 0.9,
    style,
    velocityWidth:
      mode === "pen"
        ? {
            ...FREEHAND_PEN_VELOCITY,
            scale: (1 / SCREEN_VELOCITY_FULL) * worldToScreenScale,
          }
        : undefined,
  };
}

export function isFreehandPoint(value: unknown): value is FreehandPoint {
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

  // Persisted points already carry the widths computed while drawing.
  // Recomputing velocity widths here would depend on the viewer's current zoom
  // and on the pre-layout 1x1 screen during initial load, so only derive widths
  // when none were stored.
  const options = createFreehandOptions(style, "pen", worldToScreenScale);
  if (points.some((point) => point.width !== undefined)) {
    options.velocityWidth = undefined;
  }
  const stroke = buildFreehandStroke(points, options);
  return {
    id,
    updatedAt:
      typeof read("updatedAt") === "number" && Number.isFinite(read("updatedAt"))
        ? Number(read("updatedAt"))
        : Date.now(),
    ...stroke,
  };
}

function distanceToSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function hitTestCanvasStroke(
  strokes: CanvasStroke[],
  world: { x: number; y: number },
  worldToScreenScale: number,
): string | null {
  const scale = worldToScreenScale || 1;
  // Search topmost (last drawn) first.
  for (let i = strokes.length - 1; i >= 0; i -= 1) {
    const stroke = strokes[i];
    const points = stroke.points;
    const threshold = stroke.style.width / 2 + 8 / scale;
    if (points.length === 1) {
      if (Math.hypot(world.x - points[0].x, world.y - points[0].y) <= threshold) {
        return stroke.id;
      }
      continue;
    }
    for (let j = 1; j < points.length; j += 1) {
      if (distanceToSegment(world, points[j - 1], points[j]) <= threshold) {
        return stroke.id;
      }
    }
  }
  return null;
}

function freehandPointFromPointerEvent(
  event: PointerEvent,
  world: { x: number; y: number },
  mode: DrawStrokeMode,
): FreehandPoint {
  // Only trust pressure from a stylus. Mice report a constant 0.5 while a button
  // is held, and touch rarely reports meaningful pressure, so for those inputs
  // width falls back to velocity-based tapering.
  const hasStylusPressure =
    mode === "pen" && event.pointerType === "pen" && event.pressure > 0;
  return {
    x: world.x,
    y: world.y,
    pressure: hasStylusPressure ? event.pressure : undefined,
    time: event.timeStamp,
  };
}

export function startCanvasDrawingStroke(
  event: PointerEvent,
  world: { x: number; y: number },
  options: {
    color: string;
    mode: DrawStrokeMode;
    worldToScreenScale: number;
  },
): { session: CanvasDrawingSession; stroke: FreehandStroke } | null {
  if (event.button !== 0 || (event.pointerType === "touch" && !event.isPrimary)) {
    return null;
  }

  const builder = createFreehandStrokeBuilder(
    createFreehandOptions(
      { ...FREEHAND_STYLE, color: options.color },
      options.mode,
      options.worldToScreenScale,
    ),
  );
  return {
    session: {
      pointerId: event.pointerId,
      builder,
      mode: options.mode,
    },
    stroke: builder.startAt(freehandPointFromPointerEvent(event, world, options.mode)),
  };
}

export function addCanvasDrawingPoint(
  session: CanvasDrawingSession,
  event: PointerEvent,
  world: { x: number; y: number },
): FreehandStroke | null {
  if (session.pointerId !== event.pointerId) return null;
  return session.builder.addPoint(
    freehandPointFromPointerEvent(event, world, session.mode),
  );
}

export function finishCanvasDrawingStroke(
  session: CanvasDrawingSession,
): CanvasStrokeSnapshot | null {
  const finished = session.builder.finish();
  if (finished.points.length === 0) return null;
  return {
    id: `stroke-${crypto.randomUUID()}`,
    points: finished.points.map(cloneFreehandPoint),
    style: { ...finished.style },
    updatedAt: Date.now(),
  };
}

function themedStroke(stroke: FreehandStroke, defaultInkColor: string): FreehandStroke {
  if (stroke.style.color !== FREEHAND_STYLE.color) {
    return stroke;
  }

  return {
    ...stroke,
    style: {
      ...stroke.style,
      color: defaultInkColor,
    },
  };
}

function drawShapeOutline(
  context: CanvasRenderingContext2D,
  bounds: { x: number; y: number; width: number; height: number; type?: string },
  transform: WorldTransform,
  strokeStyle: string,
) {
  const expand = bounds.type === "section" ? 4 : 2;
  const sx = bounds.x * transform.scale + transform.dx - expand;
  const sy = bounds.y * transform.scale + transform.dy - expand;
  const sw = bounds.width * transform.scale + expand * 2;
  const sh = bounds.height * transform.scale + expand * 2;
  const r = Math.max(0, 8 * transform.scale + expand);
  context.save();
  context.strokeStyle = strokeStyle;
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(sx, sy, sw, sh, r);
  context.stroke();
  context.restore();
}

export function renderCanvasInk(params: {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  strokes: CanvasStroke[];
  activeStroke: FreehandStroke | null;
  snapGuides: SnapGuide[];
  defaultInkColor: string;
}) {
  const { context, dpr, screen, transform, strokes, activeStroke, snapGuides, defaultInkColor } =
    params;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.width, screen.height);

  for (const stroke of strokes) {
    drawFreehandStroke(context, themedStroke(stroke, defaultInkColor), transform);
  }
  if (activeStroke) {
    drawFreehandStroke(context, themedStroke(activeStroke, defaultInkColor), transform);
  }

  drawSnapGuides(context, snapGuides, transform, screen, { color: "#2563eb" });
}

export function renderCanvasSelections(params: {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  strokes: CanvasStroke[];
  selectedStrokeIds: Set<string>;
  remoteSelectedStrokeIds?: Array<{ ids: Set<string>; color: string }>;
  selectedShapeBounds?: Array<{ x: number; y: number; width: number; height: number; type?: string }>;
  remoteSelectedShapeBounds?: Array<{ x: number; y: number; width: number; height: number; type?: string; color: string }>;
}) {
  const {
    context,
    dpr,
    screen,
    transform,
    strokes,
    selectedStrokeIds,
    remoteSelectedStrokeIds = [],
    selectedShapeBounds = [],
    remoteSelectedShapeBounds = [],
  } = params;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.width, screen.height);

  if (selectedStrokeIds.size > 0) {
    context.save();
    context.strokeStyle = "#2563eb";
    context.lineWidth = 1.5;
    context.setLineDash([]);
    for (const id of selectedStrokeIds) {
      const stroke = strokes.find((s) => s.id === id);
      if (!stroke || stroke.points.length === 0) continue;
      drawFreehandOutline(context, stroke, transform, 4);
    }
    context.restore();
  }

  for (const selection of remoteSelectedStrokeIds) {
    if (selection.ids.size === 0) continue;
    context.save();
    context.strokeStyle = selection.color;
    context.lineWidth = 1.5;
    context.setLineDash([]);
    for (const id of selection.ids) {
      const stroke = strokes.find((s) => s.id === id);
      if (!stroke || stroke.points.length === 0) continue;
      drawFreehandOutline(context, stroke, transform, 4);
    }
    context.restore();
  }

  for (const bounds of selectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, "#2563eb");
  }

  for (const bounds of remoteSelectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, bounds.color);
  }
}
