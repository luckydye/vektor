/**
 * Ink painting: the pen's stroke style, and every surface strokes are drawn on.
 *
 * Split from the draw tool because the engine paints ink on every frame whether
 * or not the tool is active — a canvas full of strokes still renders when the
 * select tool is in hand. The tool owns the gesture; this owns the pixels.
 *
 * Drawn immediately, like everything else on the scene canvas. Culling by
 * `strokePointBounds` — memoized per stroke — is what keeps that affordable, so
 * a frame costs the strokes actually on screen rather than the document's.
 */

import {
  drawFreehandStroke,
  FREEHAND_STYLE,
  type FreehandStroke,
  maxStrokeWidth,
  strokePointBounds,
} from "#canvas/render/freehand.ts";
import { drawSnapGuides } from "#canvas/render/snapGuides.ts";
import type { CanvasStroke } from "#canvas/runtime/extensionApi.ts";
import type { ScreenSize, SnapGuide, WorldTransform } from "#canvas/runtime/geometry.ts";

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

type CanvasStrokesParams = {
  context: CanvasRenderingContext2D;
  screen: ScreenSize;
  transform: WorldTransform;
  strokes: readonly CanvasStroke[];
  defaultInkColor: string;
};

/**
 * Completed strokes, into a caller-owned canvas that is not cleared first — the
 * scene canvas is shared with the grid, shapes and selection.
 */
export function drawCanvasStrokes(params: CanvasStrokesParams) {
  const { context, screen, transform, strokes, defaultInkColor } = params;
  const minX = -transform.dx / transform.scale;
  const minY = -transform.dy / transform.scale;
  const maxX = (screen.width - transform.dx) / transform.scale;
  const maxY = (screen.height - transform.dy) / transform.scale;

  for (const stroke of strokes) {
    const bounds = strokePointBounds(stroke);
    const padding = maxStrokeWidth(stroke.style);
    if (
      !bounds ||
      bounds.maxX + padding < minX ||
      bounds.minX - padding > maxX ||
      bounds.maxY + padding < minY ||
      bounds.minY - padding > maxY
    ) {
      continue;
    }
    drawFreehandStroke(context, themedStroke(stroke, defaultInkColor), transform);
  }
}

/**
 * The overlay canvas: the stroke currently under the pointer, plus the snap
 * guides. Its own surface because it repaints at pointer rate while the scene
 * behind it does not.
 */
export function renderCanvasInkOverlay(params: {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  activeStroke: FreehandStroke | null;
  snapGuides: SnapGuide[];
  defaultInkColor: string;
}) {
  const { context, dpr, screen, transform, activeStroke, snapGuides, defaultInkColor } =
    params;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.width, screen.height);
  if (activeStroke) {
    drawFreehandStroke(context, themedStroke(activeStroke, defaultInkColor), transform);
  }
  drawSnapGuides(context, snapGuides, transform, screen, { color: "#2563eb" });
}
