/**
 * Selection outlines: a ring around every selected stroke and shape, local and
 * remote.
 *
 * Painted into the scene canvas alongside the ink it outlines, so a selection
 * and the element under it can never disagree about where they are.
 */

import {
  drawRetainedFreehandSelection,
  type RetainedFreehandSelectionGroup,
  retainFreehandOutlines,
} from "#canvas/render/freehand.ts";
import type { CanvasStroke } from "#canvas/runtime/extensionApi.ts";
import type { WorldTransform } from "#canvas/runtime/geometry.ts";

type CanvasSelectionSnapshot = {
  strokes: CanvasStroke[];
  selectedStrokeIds: Set<string>;
  remoteSelectedStrokeIds?: Array<{ ids: Set<string>; color: string }>;
  // Present for a multi-item local selection, adding one axis-aligned bounds
  // box around the individual item outlines for group transforms.
  selectionBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  selectedShapeBounds?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    type?: string;
  }>;
  remoteSelectedShapeBounds?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    type?: string;
    color: string;
  }>;
};

type CanvasSelectionRenderParams = CanvasSelectionSnapshot & {
  context: CanvasRenderingContext2D;
  transform: WorldTransform;
};

export function drawCanvasSelections(params: CanvasSelectionRenderParams) {
  const {
    context,
    transform,
    strokes,
    selectedStrokeIds,
    remoteSelectedStrokeIds = [],
    selectionBounds,
    selectedShapeBounds = [],
    remoteSelectedShapeBounds = [],
  } = params;

  context.setLineDash([]);
  drawRetainedFreehandSelection(
    context,
    retainCanvasSelectionStrokes({ strokes, selectedStrokeIds }, transform),
    transform,
  );

  for (const bounds of selectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, "#2563eb");
  }

  if (selectionBounds) {
    drawShapeOutline(context, selectionBounds, transform, "#2563eb");
  }

  drawRetainedFreehandSelection(
    context,
    retainCanvasSelectionStrokes(
      { strokes, selectedStrokeIds: new Set(), remoteSelectedStrokeIds },
      transform,
    ),
    transform,
  );

  for (const bounds of remoteSelectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, bounds.color);
  }
}

function retainCanvasSelectionStrokes(
  selection: Pick<
    CanvasSelectionSnapshot,
    "strokes" | "selectedStrokeIds" | "remoteSelectedStrokeIds"
  >,
  transform: WorldTransform,
) {
  const strokesById = new Map(selection.strokes.map((stroke) => [stroke.id, stroke]));
  const groups: RetainedFreehandSelectionGroup[] = [];
  const retainGroup = (ids: Set<string>, color: string) => {
    const strokes: CanvasStroke[] = [];
    for (const id of ids) {
      const stroke = strokesById.get(id);
      if (stroke) strokes.push(stroke);
    }
    const outlines = retainFreehandOutlines(strokes, transform);
    if (outlines.length > 0) groups.push({ outlines, color });
  };

  retainGroup(selection.selectedStrokeIds, "#2563eb");
  for (const remote of selection.remoteSelectedStrokeIds ?? []) {
    retainGroup(remote.ids, remote.color);
  }
  return groups;
}

function drawShapeOutline(
  context: CanvasRenderingContext2D,
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    type?: string;
  },
  transform: WorldTransform,
  strokeStyle: string,
) {
  const expand = bounds.type === "section" ? 4 : 2;
  const sx = (bounds.x + bounds.width / 2) * transform.scale + transform.dx;
  const sy = (bounds.y + bounds.height / 2) * transform.scale + transform.dy;
  const sw = bounds.width * transform.scale + expand * 2;
  const sh = bounds.height * transform.scale + expand * 2;
  context.save();
  context.translate(sx, sy);
  context.rotate(((bounds.rotation ?? 0) * Math.PI) / 180);
  context.strokeStyle = strokeStyle;
  context.lineWidth = 1.5;
  context.beginPath();
  context.rect(-sw / 2, -sh / 2, sw, sh);
  context.stroke();
  context.restore();
}
