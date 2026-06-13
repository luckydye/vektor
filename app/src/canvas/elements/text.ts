import type { CanvasElementDefinition, CanvasShape } from "./types.ts";

export const textElement: CanvasElementDefinition = {
  type: "text",
  defaultText: "Text",
  defaultColor: "#ffffff",
  defaultSize: { width: 220, height: 88 },
  minSize: { width: 32, height: 40 },
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
    text: textElement.defaultText,
    color: textElement.defaultColor,
    updatedAt: Date.now(),
  };
}

export function shouldRemoveTextShape(value: string): boolean {
  return value.trim() === "";
}
