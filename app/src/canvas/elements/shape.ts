import { shapeCircleIcon, shapeRectangleIcon } from "#assets/icons.ts";
import type { TranslationKey } from "#utils/lang.ts";
import type { FreehandPoint } from "#viewport/index.ts";
import { FREEHAND_STYLE } from "./drawing.ts";
import type { CanvasSize, CanvasStrokeSnapshot } from "./types.ts";

// Outline width in world units — slightly thinner than a default pencil
// stroke so stamped shapes read as deliberate outlines.
const SHAPE_STROKE_WIDTH = 6;

// Distance between sampled outline points in world units. The ink renderer
// smooths between points, so corners and arcs need dense sampling to stay
// crisp instead of being rounded off.
const OUTLINE_STEP = 6;

// One placeable entry in the toolbar shape picker. Placed shapes are ordinary
// freehand strokes — each item just traces a different outline. The default
// library below covers the geometric primitives; future sources (e.g. shapes
// saved from the canvas as favorites) extend the picker by contributing more
// items.
export type CanvasShapeLibraryItem = {
  id: string;
  label: TranslationKey;
  // Raw SVG markup rendered in the picker button.
  icon: string;
  size: CanvasSize;
  // World-space outline polyline for a shape whose bounding box sits at `at`.
  // The polyline should end on its first point so the stroke closes.
  outline: (at: { x: number; y: number }, size: CanvasSize) => FreehandPoint[];
};

function rectangleOutline(
  at: { x: number; y: number },
  size: CanvasSize,
): FreehandPoint[] {
  const corners = [
    { x: at.x, y: at.y },
    { x: at.x + size.width, y: at.y },
    { x: at.x + size.width, y: at.y + size.height },
    { x: at.x, y: at.y + size.height },
    { x: at.x, y: at.y },
  ];
  const points: FreehandPoint[] = [];
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1];
    const to = corners[i];
    const steps = Math.max(
      1,
      Math.round(Math.hypot(to.x - from.x, to.y - from.y) / OUTLINE_STEP),
    );
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      points.push({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
    }
  }
  points.push({ ...corners[0] });
  return points;
}

function ellipseOutline(at: { x: number; y: number }, size: CanvasSize): FreehandPoint[] {
  const rx = size.width / 2;
  const ry = size.height / 2;
  const cx = at.x + rx;
  const cy = at.y + ry;
  // Perimeter approximation just to pick a segment count matching the
  // sampling density of the straight edges.
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const segments = Math.max(24, Math.round(perimeter / OUTLINE_STEP));
  const points: FreehandPoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return points;
}

export const SHAPE_LIBRARY: CanvasShapeLibraryItem[] = [
  {
    id: "rectangle",
    label: "Rectangle",
    icon: shapeRectangleIcon,
    size: { width: 220, height: 160 },
    outline: rectangleOutline,
  },
  {
    id: "circle",
    label: "Circle",
    icon: shapeCircleIcon,
    size: { width: 180, height: 180 },
    outline: ellipseOutline,
  },
];

const itemsById = new Map(SHAPE_LIBRARY.map((item) => [item.id, item]));

export function getShapeLibraryItem(id: string): CanvasShapeLibraryItem | undefined {
  return itemsById.get(id);
}

// Builds the stroke a library item stamps onto the canvas. The result is a
// regular freehand stroke: it renders on the ink layer and supports the same
// selection, move, recolor, erase, and undo behavior as drawn strokes.
export function createShapeStroke(
  item: CanvasShapeLibraryItem,
  at: { x: number; y: number },
  color: string,
): CanvasStrokeSnapshot {
  return {
    id: `stroke-${crypto.randomUUID()}`,
    kind: "shape",
    rotation: 0,
    points: item.outline({ x: Math.round(at.x), y: Math.round(at.y) }, item.size),
    style: { ...FREEHAND_STYLE, color, width: SHAPE_STROKE_WIDTH },
    updatedAt: Date.now(),
  };
}
