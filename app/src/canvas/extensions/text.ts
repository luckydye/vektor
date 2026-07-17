import { textToolIcon } from "#assets/icons.ts";
import { CanvasRichTextElement } from "./CanvasElementBase.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

export const textElement: CanvasElementExtension = {
  type: "text",
  defaults: {
    size: { width: 220, height: 88 },
    minSize: { width: 32, height: 40 },
    style: { color: "#ffffff" },
    data: { text: "", fontScale: 1 },
  },
  creation: {
    tool: { id: "text", label: "Text", shortcut: "T", icon: textToolIcon },
    editOnCreate: "element",
    doubleClick: true,
    create: (at) => createTextShape(at),
  },
  render: {
    surface: "dom",
    tag: "canvas-text",
    article: {
      style: (shape) => ({
        "--canvas-text-font-size": `${15 * (Number(shape.data.fontScale) || 1)}px`,
      }),
    },
  },
  behavior: {
    transform: { move: true, resize: "font", rotate: true },
    editableBody: true,
    measurement: {
      fallback: (shape) => {
        const text = typeof shape.data.text === "string" ? shape.data.text : "";
        const lines = (text || String(textElement.defaults.data.text ?? "")).split(/\n/);
        const longest = Math.max(1, ...lines.map((line) => line.length));
        return {
          width: Math.max(
            textElement.defaults.minSize.width,
            Math.ceil(longest * 8.5 + 26),
          ),
          height: Math.max(
            textElement.defaults.minSize.height,
            Math.ceil(lines.length * 20.25 + 22),
          ),
        };
      },
    },
  },
  input: {
    paste: [
      {
        priority: 20,
        handle: (event, context) => {
          const html = context.data?.getData("text/html") ?? "";
          if (!html.trim()) return false;
          const text = context.data?.getData("text/plain") ?? "";
          if (context.command("paste-rich", { html, text, at: context.at() }) !== true) {
            return false;
          }
          event.preventDefault();
          return true;
        },
      },
      {
        priority: 10,
        handle: (event, context) => {
          const text = context.data?.getData("text/plain") ?? "";
          if (!text.trim()) return false;
          event.preventDefault();
          context.command("paste-rich", { html: "", text, at: context.at() });
          return true;
        },
      },
    ],
  },
};

// Text body: just the rich-text editor, which doubles as the drag target when
// it isn't focused for editing.
class CanvasTextElement extends CanvasRichTextElement {
  protected readonly showHandle = false;
  protected readonly dragFromEditor = true;
  protected readonly removeWhenEmpty = true;
  protected readonly autoSize = true;
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-text")) {
  customElements.define("canvas-text", CanvasTextElement);
}

export function createTextShape(at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "text",
    frame: {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: textElement.defaults.minSize.width,
      height: textElement.defaults.minSize.height,
      rotation: 0,
    },
    style: { ...textElement.defaults.style },
    data: { ...textElement.defaults.data },
    updatedAt: Date.now(),
  };
}

export function shouldRemoveTextShape(value: string): boolean {
  return value.trim() === "";
}
