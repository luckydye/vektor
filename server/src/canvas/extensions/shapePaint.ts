/**
 * Helpers the built-in painters share: boxes and text placed in a shape's own
 * rotated frame, and the rich-text editor's stylesheet as a layout theme, so a
 * painted note matches the live `<rich-text-editor>` mounted while editing.
 */

import { remembered } from "#canvas/render/lru.ts";
import type { ScreenQuad } from "#canvas/render/primitives.ts";
import type { RichTextTheme } from "#canvas/render/richText.ts";
import { richTextLayout } from "#canvas/render/richText.ts";
import type { TextPlacement } from "#canvas/render/text.ts";
import type { TextLayout } from "#canvas/render/textLayout.ts";
import type { CanvasPaintHelpers, CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { pointOnRotatedShape } from "#canvas/runtime/geometry.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";

/** `.tiptap` in `rich-text-editor.ts` at a given font size. */
export function editorTheme(size: number, color: string): RichTextTheme {
  return {
    size,
    lineHeight: 1.35,
    color,
    headings: [1.75, 1.4, 1.2, 1.05, 1, 1].map((em) => em * size),
    headingLineHeight: 1.2,
    headingColor: color,
    headingFace: "bold",
    blockMargin: 0,
    headingMargin: { top: 0, bottom: 0 },
    listIndent: 24,
    itemMargin: 2,
    link: "#2563eb",
    muted: color,
    codeBackground: "rgba(15, 23, 42, 0.08)",
    divider: "rgba(15, 23, 42, 0.16)",
    accent: "#2563eb",
  };
}

const markdownHtml = new Map<string, string>();

export function shapeMarkdownHtml(shape: CanvasShape): string {
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  return remembered(markdownHtml, text, 4096, () => renderMessageMarkdown(text));
}

export function shapeTextLayout(
  shape: CanvasShape,
  theme: RichTextTheme,
  width: number,
  invalidate: () => void,
): TextLayout | null {
  return richTextLayout(shapeMarkdownHtml(shape), theme, width, invalidate);
}

/** A placement for content whose top-left sits at `local` inside the shape. */
export function shapePlacement(
  shape: CanvasShape,
  helpers: Pick<CanvasPaintHelpers, "scale" | "dx" | "dy">,
  local: { x: number; y: number },
  clip?: TextPlacement["clip"],
): TextPlacement {
  const world = pointOnRotatedShape(shape.frame, local);
  return {
    origin: {
      x: world.x * helpers.scale + helpers.dx,
      y: world.y * helpers.scale + helpers.dy,
    },
    scale: helpers.scale,
    rotation: (shape.frame.rotation * Math.PI) / 180,
    clip,
  };
}

/** A box at `x, y` in the shape's own frame, as a screen quad. */
export function shapeQuad(
  shape: CanvasShape,
  helpers: Pick<CanvasPaintHelpers, "scale" | "dx" | "dy">,
  x: number,
  y: number,
  width: number,
  height: number,
): ScreenQuad {
  const placement = shapePlacement(shape, helpers, { x, y });
  const cos = Math.cos(placement.rotation) * helpers.scale;
  const sin = Math.sin(placement.rotation) * helpers.scale;
  return {
    origin: placement.origin,
    axisX: { x: cos * width, y: sin * width },
    axisY: { x: -sin * height, y: cos * height },
  };
}
