import { noteToolIcon } from "#assets/icons.ts";
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
  defaults: {
    size: { width: 240, height: 150 },
    minSize: { width: 140, height: 96 },
    style: { color: NOTE_COLORS[0] },
    data: { text: "Note" },
  },
  creation: {
    palette: NOTE_COLORS,
    tool: { id: "note", label: "Note", shortcut: "N", icon: noteToolIcon },
    editOnCreate: "element",
    create: (at, ctx) =>
      createNoteShape(at, ctx.color ?? noteElement.defaults.style.color),
  },
  render: { surface: "dom", tag: "canvas-note" },
  behavior: { transform: { move: true, resize: "box", rotate: true } },
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
  color = noteElement.defaults.style.color,
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "note",
    frame: {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: noteElement.defaults.size.width,
      height: noteElement.defaults.size.height,
      rotation: 0,
    },
    style: { color },
    data: { ...noteElement.defaults.data },
    updatedAt: Date.now(),
  };
}
