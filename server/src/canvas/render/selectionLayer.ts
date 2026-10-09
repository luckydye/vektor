/**
 * Selection outlines: a ring around every selected stroke and shape, local and
 * remote. Drawn in the overlay pass, the only one above the DOM world.
 */

import type { FreehandStroke } from "#canvas/render/freehand.ts";
import { drawStrokeRings, type InkOffset } from "#canvas/render/ink.ts";
import { drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";

interface OutlineBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  type?: string;
}

export interface CanvasSelectionSnapshot {
  strokes: ReadonlyMap<string, FreehandStroke>;
  moved: InkOffset | null;
  /** Every selected id; the ones that name a stroke get an ink outline. */
  selectedIds: Set<string>;
  remoteSelectedStrokeIds: Array<{ ids: Set<string>; color: string }>;
  // Present for a multi-item local selection: one axis-aligned box around the
  // individual outlines, for group transforms.
  selectionBounds?: OutlineBounds;
  selectedShapeBounds: OutlineBounds[];
  remoteSelectedShapeBounds: Array<OutlineBounds & { color: string }>;
}

const LOCAL_COLOR = "#2563eb";

export function drawCanvasSelections(gpu: CanvasGpu, selection: CanvasSelectionSnapshot) {
  const strokesFor = (ids: Set<string>) =>
    [...ids].map((id) => selection.strokes.get(id)).filter((stroke) => stroke != null);

  drawStrokeRings(
    gpu,
    [{ strokes: strokesFor(selection.selectedIds), color: LOCAL_COLOR }],
    selection.moved,
  );
  for (const bounds of selection.selectedShapeBounds) {
    drawShapeOutline(gpu, bounds, LOCAL_COLOR);
  }
  if (selection.selectionBounds) {
    drawShapeOutline(gpu, selection.selectionBounds, LOCAL_COLOR);
  }
  drawStrokeRings(
    gpu,
    selection.remoteSelectedStrokeIds.map((remote) => ({
      strokes: strokesFor(remote.ids),
      color: remote.color,
    })),
    selection.moved,
  );
  for (const bounds of selection.remoteSelectedShapeBounds) {
    drawShapeOutline(gpu, bounds, bounds.color);
  }
}

function drawShapeOutline(gpu: CanvasGpu, bounds: OutlineBounds, color: string) {
  const { transform } = gpu.view;
  // A section's outline lies exactly on its border, where its handles sit.
  const frame = bounds.type === "section";
  const expand = frame ? 0 : 2;
  const width = bounds.width * transform.scale + expand * 2;
  const height = bounds.height * transform.scale + expand * 2;
  const cx = (bounds.x + bounds.width / 2) * transform.scale + transform.dx;
  const cy = (bounds.y + bounds.height / 2) * transform.scale + transform.dy;
  drawRoundedRect(
    gpu,
    rectQuad(
      cx - width / 2,
      cy - height / 2,
      width,
      height,
      ((bounds.rotation ?? 0) * Math.PI) / 180,
    ),
    { stroke: parseColor(color), strokeWidth: frame ? 1 : 1.5 },
  );
}
