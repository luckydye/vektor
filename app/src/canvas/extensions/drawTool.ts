/**
 * The draw tool: turns a pointer gesture into a committed stroke.
 *
 * A tool extension, registered like any other, so the engine has no
 * draw-specific branch. Everything about how ink *looks* lives in
 * `render/ink.ts`; this owns only the gesture and the pen's UI state.
 */
import { cloneFreehandPoint } from "#canvas/document/strokes.ts";
import {
  createFreehandOptions,
  createFreehandStrokeBuilder,
  type DrawStrokeMode,
  FREEHAND_STYLE,
  type FreehandPoint,
  type FreehandStroke,
  type FreehandStrokeBuilder,
} from "#canvas/render/freehand.ts";
import type {
  CanvasPointerGestureSample,
  CanvasStrokeSnapshot,
  CanvasToolProperty,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasTool } from "#canvas/runtime/extensionApi.ts";
import { iconMarkup } from "#components/Icon.tsx";
import type { TranslationKey } from "#utils/lang.ts";

type CanvasDrawingSession = {
  pointerId: number;
  builder: FreehandStrokeBuilder;
  mode: DrawStrokeMode;
};

export const PEN_COLORS = [
  "#111827",
  "#ef4444",
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
] as const;

const DRAW_STROKE_MODES: Array<{
  id: DrawStrokeMode;
  label: TranslationKey;
  icon: string;
}> = [
  {
    id: "pencil",
    label: "Pencil",
    icon: iconMarkup("pen-tool"),
  },
  {
    id: "pen",
    label: "Pen",
    icon: iconMarkup("pen-tool"),
  },
];

/**
 * Stroke widths offered by the size control, in world units.
 *
 * World units, not screen pixels, so a stroke drawn zoomed out stays the same
 * thickness relative to the canvas when you zoom back in.
 */
const PEN_SIZES = [2, 6, 10, 18, 32] as const;

const DRAW_TOOL_PROPERTIES = [
  {
    kind: "choice",
    id: "mode",
    label: "Pen",
    options: DRAW_STROKE_MODES,
    default: "pen",
  },
  {
    kind: "size",
    id: "size",
    label: "Size",
    options: PEN_SIZES,
    default: FREEHAND_STYLE.width,
  },
] as const satisfies readonly CanvasToolProperty[];

// addVelocityWidths measures velocity in world units/ms, so it would otherwise
// taper differently depending on zoom. Multiplying the scale by the current
// world->screen scale makes the taper track on-screen pointer speed instead.

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

function startCanvasDrawingStroke(
  event: PointerEvent,
  world: { x: number; y: number },
  options: {
    color: string;
    mode: DrawStrokeMode;
    size: number;
    worldToScreenScale: number;
  },
): { session: CanvasDrawingSession; stroke: FreehandStroke } | null {
  if (event.button !== 0 || (event.pointerType === "touch" && !event.isPrimary)) {
    return null;
  }

  const builder = createFreehandStrokeBuilder(
    createFreehandOptions(
      { ...FREEHAND_STYLE, color: options.color, width: options.size },
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

function addCanvasDrawingPoints(
  session: CanvasDrawingSession,
  samples: readonly Pick<CanvasPointerGestureSample, "event" | "world">[],
): FreehandStroke | null {
  function* points(): Iterable<FreehandPoint> {
    for (const { event, world } of samples) {
      if (session.pointerId !== event.pointerId) continue;
      yield freehandPointFromPointerEvent(event, world, session.mode);
    }
  }

  return session.builder.addPoints(points());
}

function finishCanvasDrawingStroke(
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

// Freehand drawing is a regular extension-owned pointer gesture. The host only
// supplies coordinate conversion, pointer capture, active-stroke rendering,
// and the final stroke store through CanvasToolContext.
export const DrawTool = CanvasTool.create({
  name: "draw",
  toolbar: { label: "Draw", icon: iconMarkup("pen-tool") },
  shortcut: "D",

  addProperties() {
    return DRAW_TOOL_PROPERTIES;
  },

  onPointerDown(at, event, ctx) {
    const started = startCanvasDrawingStroke(event, at, {
      // Colour stays shared engine state rather than a tool property: the shape
      // tool stamps in the same colour, and splitting them would silently change
      // that.
      color: ctx.penColor(),
      mode: ctx.property<DrawStrokeMode>("mode"),
      size: ctx.property<number>("size"),
      worldToScreenScale: ctx.viewportScale(),
    });
    if (!started) return;

    let pendingSamples: CanvasPointerGestureSample[] = [];
    let frameId: number | null = null;
    const flushPendingSamples = (render: boolean) => {
      frameId = null;
      if (pendingSamples.length === 0) return;
      const samples = pendingSamples;
      pendingSamples = [];
      const stroke = addCanvasDrawingPoints(started.session, samples);
      if (render && stroke) ctx.setActiveStroke(stroke);
    };
    const cancelPendingFrame = () => {
      if (frameId === null) return;
      cancelAnimationFrame(frameId);
      frameId = null;
    };

    ctx.beginPointerGesture(event, {
      onMove: ({ samples }) => {
        pendingSamples.push(...samples);
        if (frameId === null) {
          frameId = requestAnimationFrame(() => flushPendingSamples(true));
        }
      },
      onEnd: () => {
        cancelPendingFrame();
        flushPendingSamples(false);
        const stroke = finishCanvasDrawingStroke(started.session);
        ctx.setActiveStroke(null);
        if (stroke) ctx.insertStroke(stroke);
      },
      onCancel: () => {
        cancelPendingFrame();
        pendingSamples = [];
        ctx.setActiveStroke(null);
      },
    });
    ctx.clearSelection();
    ctx.setActiveStroke(started.stroke);
  },
});
