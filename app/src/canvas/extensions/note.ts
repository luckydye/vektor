import { canvasNoteIcon } from "#assets/icons.ts";
import { CanvasRichTextElement } from "./CanvasElementBase.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

export const NOTE_COLORS = [
  "#fef3c7",
  "#dcfce7",
  "#dbeafe",
  "#fae8ff",
  "#fee2e2",
] as const;

export const noteElement: CanvasElementExtension = {
  type: "note",
  defaultText: "Note",
  defaultColor: NOTE_COLORS[0],
  defaultSize: { width: 240, height: 150 },
  minSize: { width: 140, height: 96 },
  surface: "dom",
  tag: "canvas-note",
  transform: { move: true, resize: "box", rotate: true },
  palette: NOTE_COLORS,
  tool: { id: "note", label: "Note", shortcut: "N", icon: canvasNoteIcon },
  create: (at, ctx) => createNoteShape(at, ctx.color ?? noteElement.defaultColor),
};

// Note body: a drag grip plus the rich-text editor.
class CanvasNoteElement extends CanvasRichTextElement {
  protected readonly showHandle = true;
  protected readonly dragFromEditor = false;
  protected readonly removeWhenEmpty = false;
  protected readonly autoSize = false;
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-note")) {
  customElements.define("canvas-note", CanvasNoteElement);
}

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
