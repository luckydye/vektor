import { canvasTextIcon } from "#assets/icons.ts";
import { CanvasRichTextElement } from "./CanvasElementBase.ts";
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
  tool: { id: "text", label: "Text", shortcut: "T", icon: canvasTextIcon },
  editOnCreate: "body",
  // The whole card is the editor, so host pointer handlers must not preventDefault.
  editableBody: true,
  create: (at) => createTextShape(at),
  // Text auto-sizes to its content, so its box is never persisted — only
  // fontScale is. Strip width/height on the way out.
  serialize: (shape) => {
    const { width: _width, height: _height, ...rest } = shape;
    return rest as CanvasSerializedShape;
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
