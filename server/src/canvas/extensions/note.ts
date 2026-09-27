import { CanvasRichTextElement } from "#canvas/runtime/elementBase.ts";
import type { CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { iconMarkup } from "#components/Icon.tsx";

const NOTE_COLORS = ["#fef3c7", "#dcfce7", "#dbeafe", "#fae8ff", "#fee2e2"] as const;

export const Note = CanvasElement.create({
  name: "note",

  addOptions() {
    return {
      colors: NOTE_COLORS as readonly string[],
      size: { width: 240, height: 150 },
      minSize: { width: 140, height: 96 },
      text: "Note",
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: this.options.colors[0] },
      data: { text: this.options.text },
    };
  },

  addCreation() {
    // `this.options` is why none of this has to name the extension it belongs to.
    const { colors, size, text } = this.options;
    return {
      palette: colors,
      tool: {
        id: this.name,
        label: "Note" as const,
        shortcut: "N",
        icon: iconMarkup("note-tool"),
      },
      editOnCreate: "element" as const,
      create: (at: { x: number; y: number }, ctx: { color?: string }) =>
        createNoteShape(at, ctx.color ?? colors[0], size, text),
    };
  },

  addRender() {
    return { surface: "dom" as const, tag: "canvas-note" };
  },

  addBehavior() {
    return { transform: { move: true, resize: "box" as const, rotate: true } };
  },
});

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

function createNoteShape(
  at: { x: number; y: number },
  color: string = NOTE_COLORS[0],
  size: { width: number; height: number } = Note.defaults.size,
  text = "Note",
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "note",
    frame: {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: size.width,
      height: size.height,
      rotation: 0,
    },
    style: { color },
    data: { text },
    updatedAt: Date.now(),
  };
}
