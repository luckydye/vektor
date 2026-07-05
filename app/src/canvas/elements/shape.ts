import { shapeCircleIcon, shapeRectangleIcon } from "../../assets/icons.ts";
import type { TranslationKey } from "../../utils/lang.ts";
import type { WorldTransform } from "../../viewport/index.ts";
import type { CanvasElementDefinition, CanvasShape, CanvasSize } from "./types.ts";

export const shapeElement: CanvasElementDefinition = {
  type: "shape",
  defaultText: "",
  defaultColor: "#dbeafe",
  defaultSize: { width: 220, height: 160 },
  minSize: { width: 48, height: 48 },
};

// One placeable entry in the toolbar shape picker. The default library below
// covers the geometric primitives; future sources (e.g. shapes saved from the
// canvas as favorites) extend the picker by contributing more items.
export type CanvasShapeLibraryItem = {
  // Stored on placed shapes as `variant`; selects the geometry when painting.
  id: string;
  label: TranslationKey;
  // Raw SVG markup rendered in the picker button.
  icon: string;
  create: (at: { x: number; y: number }) => CanvasShape;
  // Traces the variant's outline (screen-space rect) into the current path.
  trace: (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    scale: number,
  ) => void;
  // Refines a bounding-box hit into the variant's real outline. Absent means
  // the bounding box is the outline (rectangle).
  hitTest?: (shape: CanvasShape, point: { x: number; y: number }) => boolean;
};

function geometricShapeItem(options: {
  id: string;
  label: TranslationKey;
  icon: string;
  size?: CanvasSize;
  trace: CanvasShapeLibraryItem["trace"];
  hitTest?: CanvasShapeLibraryItem["hitTest"];
}): CanvasShapeLibraryItem {
  return {
    id: options.id,
    label: options.label,
    icon: options.icon,
    trace: options.trace,
    hitTest: options.hitTest,
    create: (at) => ({
      id: `shape-${crypto.randomUUID()}`,
      type: "shape",
      variant: options.id,
      x: Math.round(at.x),
      y: Math.round(at.y),
      ...(options.size ?? shapeElement.defaultSize),
      text: shapeElement.defaultText,
      color: shapeElement.defaultColor,
      updatedAt: Date.now(),
    }),
  };
}

export const SHAPE_LIBRARY: CanvasShapeLibraryItem[] = [
  geometricShapeItem({
    id: "rectangle",
    label: "Rectangle",
    icon: shapeRectangleIcon,
    trace: (ctx, x, y, width, height, scale) => {
      ctx.roundRect(x, y, width, height, Math.min(8 * scale, width / 2, height / 2));
    },
  }),
  geometricShapeItem({
    id: "circle",
    label: "Circle",
    icon: shapeCircleIcon,
    size: { width: 180, height: 180 },
    trace: (ctx, x, y, width, height) => {
      ctx.ellipse(
        x + width / 2,
        y + height / 2,
        width / 2,
        height / 2,
        0,
        0,
        Math.PI * 2,
      );
    },
    hitTest: (shape, point) => {
      const rx = shape.width / 2;
      const ry = shape.height / 2;
      if (rx <= 0 || ry <= 0) return false;
      const nx = (point.x - (shape.x + rx)) / rx;
      const ny = (point.y - (shape.y + ry)) / ry;
      return nx * nx + ny * ny <= 1;
    },
  }),
];

const itemsById = new Map(SHAPE_LIBRARY.map((item) => [item.id, item]));

export function getShapeLibraryItem(id: string): CanvasShapeLibraryItem | undefined {
  return itemsById.get(id);
}

// Paints a geometric shape onto a canvas layer (same layer as image shapes,
// below the ink layer so freehand strokes draw over shapes).
export function drawShapeElement(
  ctx: CanvasRenderingContext2D,
  shape: CanvasShape,
  transform: WorldTransform,
  borderColor: string,
): void {
  const item = getShapeLibraryItem(shape.variant ?? "") ?? SHAPE_LIBRARY[0];
  const x = shape.x * transform.scale + transform.dx;
  const y = shape.y * transform.scale + transform.dy;
  const width = shape.width * transform.scale;
  const height = shape.height * transform.scale;
  if (width <= 0 || height <= 0) return;

  ctx.beginPath();
  item.trace(ctx, x, y, width, height, transform.scale);
  ctx.fillStyle = shape.color;
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = Math.max(0.75, transform.scale);
  ctx.stroke();
}

// World-space hit test against the variant's real outline, not just the
// bounding box, so e.g. a circle's corners don't capture clicks.
export function hitTestShapeElement(
  shape: CanvasShape,
  point: { x: number; y: number },
): boolean {
  if (
    point.x < shape.x ||
    point.x > shape.x + shape.width ||
    point.y < shape.y ||
    point.y > shape.y + shape.height
  ) {
    return false;
  }
  const item = getShapeLibraryItem(shape.variant ?? "");
  return item?.hitTest ? item.hitTest(shape, point) : true;
}
