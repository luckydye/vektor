import { shapeCircleIcon, shapeRectangleIcon } from "../../assets/icons.ts";
import type { TranslationKey } from "../../utils/lang.ts";
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
  // Stored on placed shapes as `variant` and drives their per-variant CSS class.
  id: string;
  label: TranslationKey;
  // Raw SVG markup rendered in the picker button.
  icon: string;
  create: (at: { x: number; y: number }) => CanvasShape;
};

function geometricShapeItem(options: {
  id: string;
  label: TranslationKey;
  icon: string;
  size?: CanvasSize;
}): CanvasShapeLibraryItem {
  return {
    id: options.id,
    label: options.label,
    icon: options.icon,
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
  }),
  geometricShapeItem({
    id: "circle",
    label: "Circle",
    icon: shapeCircleIcon,
    size: { width: 180, height: 180 },
  }),
];

export function getShapeLibraryItem(id: string): CanvasShapeLibraryItem | undefined {
  return SHAPE_LIBRARY.find((item) => item.id === id);
}
