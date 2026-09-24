import { CanvasRichTextElement } from "#canvas/runtime/elementBase.ts";
import type { CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { iconMarkup } from "#components/Icon.tsx";

export const CanvasText = CanvasElement.create({
  name: "text",

  addOptions() {
    return {
      size: { width: 220, height: 88 },
      minSize: { width: 32, height: 40 },
      /** Base font size in world units; `fontScale` multiplies it. */
      fontSize: 15,
      placeholder: "",
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "#ffffff" },
      data: { text: this.options.placeholder, fontScale: 1 },
    };
  },

  addCreation() {
    return {
      tool: {
        id: this.name,
        label: "Text" as const,
        shortcut: "T",
        icon: iconMarkup("text-tool"),
      },
      editOnCreate: "element" as const,
      doubleClick: true,
      create: (at: { x: number; y: number }) => createTextShape(at),
    };
  },

  addRender() {
    const { fontSize } = this.options;
    return {
      surface: "dom" as const,
      tag: "canvas-text",
      article: {
        style: (shape: CanvasShape) => ({
          "--canvas-text-font-size": `${fontSize * (Number(shape.data.fontScale) || 1)}px`,
        }),
      },
    };
  },

  addBehavior() {
    const { minSize, placeholder } = this.options;
    return {
      transform: { move: true, resize: "font" as const, rotate: true },
      editableBody: true,
      measurement: {
        // Text sizes itself from its content, so the persisted box is a
        // placeholder. This is the estimate used before the element has measured.
        fallback: (shape: CanvasShape) => {
          const text = typeof shape.data.text === "string" ? shape.data.text : "";
          const lines = (text || placeholder).split(/\n/);
          const longest = Math.max(1, ...lines.map((line) => line.length));
          return {
            width: Math.max(minSize.width, Math.ceil(longest * 8.5 + 26)),
            height: Math.max(minSize.height, Math.ceil(lines.length * 20.25 + 22)),
          };
        },
      },
    };
  },

  addInput() {
    return {
      paste: [
        {
          priority: 20,
          handle: (event, context) => {
            const html = context.data?.getData("text/html") ?? "";
            if (!html.trim()) return false;
            const text = context.data?.getData("text/plain") ?? "";
            if (
              context.command("paste-rich", { html, text, at: context.at() }) !== true
            ) {
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
    };
  },
});

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

function createTextShape(at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "text",
    frame: {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: CanvasText.defaults.minSize.width,
      height: CanvasText.defaults.minSize.height,
      rotation: 0,
    },
    style: { ...CanvasText.defaults.style },
    data: { ...CanvasText.defaults.data },
    updatedAt: Date.now(),
  };
}
