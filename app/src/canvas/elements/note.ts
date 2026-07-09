import type { CanvasElementDefinition, CanvasShape } from "./types.ts";

export const NOTE_COLORS = [
  "#fef3c7",
  "#dcfce7",
  "#dbeafe",
  "#fae8ff",
  "#fee2e2",
] as const;

export const noteElement: CanvasElementDefinition = {
  type: "note",
  defaultText: "Note",
  defaultColor: NOTE_COLORS[0],
  defaultSize: { width: 240, height: 150 },
  minSize: { width: 140, height: 96 },
};

export function createNoteShape(
  at: { x: number; y: number },
  color = noteElement.defaultColor,
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "note",
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: noteElement.defaultSize.width,
    height: noteElement.defaultSize.height,
    rotation: 0,
    text: noteElement.defaultText,
    color,
    updatedAt: Date.now(),
  };
}
