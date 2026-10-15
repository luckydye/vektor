/**
 * The draw tool: turns a pointer gesture into a committed stroke.
 *
 * A tool extension, registered like any other, so the engine has no
 * draw-specific branch. Everything about how ink *looks* lives in
 * `render/ink.ts`; this owns only the gesture and the pen's UI state.
 */
import {
  createFreehandRecorder,
  FREEHAND_STYLE,
  type FreehandSample,
} from "#canvas/render/freehand.ts";
import type {
  CanvasPointerGestureSample,
  CanvasToolProperty,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasTool } from "#canvas/runtime/extensionApi.ts";
import { iconMarkup } from "#components/Icon.tsx";

export const PEN_COLORS = [
  "#111827",
  "#ef4444",
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
] as const;

/**
 * Stroke widths offered by the size control, in world units.
 *
 * World units, not screen pixels, so a stroke drawn zoomed out stays the same
 * thickness relative to the canvas when you zoom back in.
 */
const PEN_SIZES = [2, 6, 10, 18, 32] as const;

const DRAW_TOOL_PROPERTIES = [
  {
    kind: "size",
    id: "size",
    label: "Size",
    options: PEN_SIZES,
    default: FREEHAND_STYLE.width,
  },
] as const satisfies readonly CanvasToolProperty[];

// Mice report a constant 0.5 while pressed and touch rarely means it, so only
// a stylus drives width by pressure; everything else drives it by speed.
function freehandSample({
  event,
  world,
}: Pick<CanvasPointerGestureSample, "event" | "world">): FreehandSample {
  return {
    x: world.x,
    y: world.y,
    pressure: event.pointerType === "pen" ? event.pressure : undefined,
    time: event.timeStamp,
  };
}

// Freehand drawing is a regular extension-owned pointer gesture. The host only
// supplies coordinate conversion, pointer capture, active-stroke rendering,
// and the final stroke store through CanvasToolContext.
export const DrawTool = CanvasTool.create({
  name: "draw",
  toolbar: { label: "Draw", icon: iconMarkup("pen-tool") },
  shortcut: "W",

  addProperties() {
    return DRAW_TOOL_PROPERTIES;
  },

  onPointerDown(at, event, ctx) {
    if (event.button !== 0 || (event.pointerType === "touch" && !event.isPrimary)) return;
    const recorder = createFreehandRecorder(
      {
        ...FREEHAND_STYLE,
        // Colour stays shared engine state rather than a tool property: the shape
        // tool stamps in the same colour, and splitting them would silently change
        // that.
        color: ctx.penColor(),
        width: ctx.property<number>("size"),
      },
      1 / ctx.viewportScale(),
    );
    const pointerId = event.pointerId;
    recorder.add([freehandSample({ event, world: at })]);

    let pendingSamples: CanvasPointerGestureSample[] = [];
    let frameId: number | null = null;
    const flushPendingSamples = (render: boolean) => {
      frameId = null;
      if (pendingSamples.length === 0) return;
      const samples = pendingSamples;
      pendingSamples = [];
      recorder.add(
        samples
          .filter((sample) => sample.event.pointerId === pointerId)
          .map(freehandSample),
      );
      if (render) ctx.setActiveStroke(recorder.stroke());
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
        const stroke = recorder.finish();
        ctx.setActiveStroke(null);
        if (stroke) {
          ctx.insertStroke({
            id: `stroke-${crypto.randomUUID()}`,
            ...stroke,
            updatedAt: Date.now(),
          });
        }
      },
      onCancel: () => {
        cancelPendingFrame();
        pendingSamples = [];
        ctx.setActiveStroke(null);
      },
    });
    ctx.clearSelection();
    ctx.setActiveStroke(recorder.stroke());
  },
});
