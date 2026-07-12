import { canvasSectionIcon } from "#assets/icons.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

// Section frame accent colors offered by the toolbar swatch.
export const SECTION_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
] as const;

// Sections are drawn entirely on a dedicated canvas layer (frame + title) and
// only expose a resize handle — they never rotate and have no DOM body.
export const sectionElement: CanvasElementExtension = {
  type: "section",
  defaultText: "Section",
  defaultColor: SECTION_COLORS[0],
  defaultSize: { width: 560, height: 340 },
  minSize: { width: 240, height: 160 },
  surface: "canvas",
  transform: { move: true, resize: "box", rotate: false },
  tool: { id: "section", label: "Section", shortcut: "S", icon: canvasSectionIcon },
  create: (at, ctx) => createSectionShape(at, ctx.color ?? sectionElement.defaultColor),
};

export function createSectionShape(
  at: { x: number; y: number },
  color = sectionElement.defaultColor,
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "section",
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: sectionElement.defaultSize.width,
    height: sectionElement.defaultSize.height,
    rotation: 0,
    text: sectionElement.defaultText,
    color,
    updatedAt: Date.now(),
  };
}
