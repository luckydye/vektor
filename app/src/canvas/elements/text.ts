import { canvasTextIcon } from "#assets/icons.ts";
import type {
  CanvasElementExtension,
  CanvasSerializedShape,
  CanvasShape,
} from "./types.ts";

export const textElement: CanvasElementExtension = {
  type: "text",
  defaultText: "",
  defaultColor: "#ffffff",
  defaultSize: { width: 220, height: 88 },
  minSize: { width: 32, height: 40 },
  surface: "dom",
  tag: "canvas-text",
  // Text auto-fits its content; resizing scales the font instead of a fixed box.
  transform: { move: true, resize: "font", rotate: true },
  autosize: "observe-dom",
  tool: { id: "text", label: "Text", shortcut: "T", icon: canvasTextIcon },
  create: (at) => createTextShape(at),
  // Text auto-sizes to its content, so its box is never persisted — only
  // fontScale is. Strip width/height on the way out.
  serialize: (shape) => {
    const { width: _width, height: _height, ...rest } = shape;
    return rest as CanvasSerializedShape;
  },
};

export function createTextShape(at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "text",
    x: Math.round(at.x),
    y: Math.round(at.y),
    // Text shapes auto-size to their content; the observer corrects this
    // placeholder right after mount.
    width: textElement.minSize.width,
    height: textElement.minSize.height,
    rotation: 0,
    text: textElement.defaultText,
    color: textElement.defaultColor,
    updatedAt: Date.now(),
  };
}

export function shouldRemoveTextShape(value: string): boolean {
  return value.trim() === "";
}
