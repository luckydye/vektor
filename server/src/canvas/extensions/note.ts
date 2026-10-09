import {
  editorTheme,
  shapePlacement,
  shapeQuad,
  shapeTextLayout,
} from "#canvas/extensions/shapePaint.ts";
import { drawRoundedRect } from "#canvas/render/primitives.ts";
import { drawTextLayout } from "#canvas/render/text.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import { CanvasRichTextElement } from "#canvas/runtime/elementBase.ts";
import type {
  CanvasClientPoint,
  CanvasPaintHelpers,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { localPointInShape } from "#canvas/runtime/geometry.ts";
import { iconMarkup } from "#components/Icon.tsx";

// The article's 1px border, the 18px drag grip and the editor's 4px padding.
const BORDER = 1;
const GRIP = 18;
const PADDING = 4;
const THEME = editorTheme(15, "#111827");

function paintNote(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const { width, height } = shape.frame;
  const box = (x: number, y: number, w: number, h: number) =>
    shapeQuad(shape, helpers, x, y, w, h);
  drawRoundedRect(gpu, box(0, 0, width, height), {
    radius: 8 * helpers.scale,
    fill: parseColor(shape.style.color),
    stroke: parseColor(helpers.color("--canvas-shape-border")),
    strokeWidth: helpers.scale,
  });
  const corner = 7 * helpers.scale;
  drawRoundedRect(gpu, box(BORDER, BORDER, width - BORDER * 2, GRIP), {
    radius: [corner, corner, 0, 0],
    fill: parseColor(helpers.color("--canvas-handle-bg")),
  });
  const inset = BORDER + PADDING;
  const contentWidth = width - inset * 2;
  const layout = shapeTextLayout(shape, THEME, contentWidth, helpers.invalidate);
  if (!layout) return;
  drawTextLayout(
    gpu,
    layout,
    shapePlacement(
      shape,
      helpers,
      { x: inset, y: BORDER + GRIP + PADDING },
      {
        x: -PADDING,
        y: -PADDING,
        width: contentWidth + PADDING * 2,
        height: height - BORDER * 2 - GRIP,
      },
    ),
  );
}

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
    return {
      paint: paintNote,
      hitTest: (shape: CanvasShape, world: { x: number; y: number }) => {
        const local = localPointInShape(shape.frame, world);
        if (local.x < 0 || local.y < 0) return null;
        if (local.x > shape.frame.width || local.y > shape.frame.height) return null;
        return local.y <= BORDER + GRIP ? "grip" : "body";
      },
      cursor: (_shape: CanvasShape, region: string) =>
        region === "grip" ? "move" : "text",
      editor: (shape: CanvasShape, at: CanvasClientPoint | null) => ({
        shapeId: shape.id,
        tag: "canvas-note",
        props: { caret: at },
      }),
    };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: true },
      press: (_shape: CanvasShape, region: string) =>
        region === "grip" ? ("drag" as const) : ("edit" as const),
    };
  },
});

// The live note, mounted only while editing: a drag grip plus the editor.
class CanvasNoteElement extends CanvasRichTextElement {
  protected readonly showHandle = true;
  protected readonly removeWhenEmpty = false;
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
