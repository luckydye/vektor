import type { TranslationKey } from "#utils/lang.ts";
import { documentLinkElement } from "./documentLink.ts";
import { drawTool } from "./drawing.ts";
import { fileElement } from "./files.ts";
import { linkElement } from "./link.ts";
import { audioElement, imageElement, videoElement } from "./media.ts";
import { noteElement } from "./note.ts";
import { sectionElement } from "./section.ts";
import { shapeTool } from "./shape.ts";
import { textElement } from "./text.ts";
import type {
  CanvasElementExtension,
  CanvasElementTool,
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasTool,
  CanvasToolExtension,
} from "./types.ts";

// The complete set of canvas element extensions. Order is the registration
// order; the host derives paint/hit-test z-order and the tool list from it.
const elementExtensions = [
  noteElement,
  textElement,
  imageElement,
  videoElement,
  audioElement,
  fileElement,
  documentLinkElement,
  linkElement,
  sectionElement,
] satisfies CanvasElementExtension[];

const extensionsByType = new Map<CanvasShapeType, CanvasElementExtension>(
  elementExtensions.map((extension) => [extension.type, extension]),
);

export function isCanvasShapeType(value: unknown): value is CanvasShapeType {
  return typeof value === "string" && extensionsByType.has(value as CanvasShapeType);
}

export function getCanvasElementExtension(
  type: CanvasShapeType,
): CanvasElementExtension | undefined {
  return extensionsByType.get(type);
}

/** Toolbar entries contributed by extensions (note/text/section), in order. */
export function canvasElementTools(): CanvasElementTool[] {
  return elementExtensions
    .map((extension) => extension.tool)
    .filter((tool): tool is CanvasElementTool => Boolean(tool));
}

/** Color-swatch palettes contributed by extensions (note/section), in order. */
export function canvasColorPalettes(): Array<{
  type: CanvasShapeType;
  label: TranslationKey;
  palette: readonly string[];
}> {
  const out: Array<{
    type: CanvasShapeType;
    label: TranslationKey;
    palette: readonly string[];
  }> = [];
  for (const extension of elementExtensions) {
    if (!extension.palette || !extension.tool) continue;
    out.push({
      type: extension.type,
      label: extension.tool.label,
      palette: extension.palette,
    });
  }
  return out;
}

// Standalone (non-element) tools. Element-creating tools are derived below.
const standaloneTools: CanvasToolExtension[] = [drawTool, shapeTool];

/**
 * The tool handling a non-select pointerdown. draw/shape are their own tool
 * extensions; note/text/section derive from their element extension's create().
 */
export function getCanvasTool(id: CanvasTool): CanvasToolExtension | undefined {
  const standalone = standaloneTools.find((tool) => tool.id === id);
  if (standalone) return standalone;
  const element = elementExtensions.find((extension) => extension.tool?.id === id);
  if (element) {
    return {
      id,
      onPointerDown: (at, _event, ctx) => ctx.createElement(element.type, at),
    };
  }
  return undefined;
}

export function defaultTextForShape(type: CanvasShapeType): string {
  return getCanvasElementExtension(type)?.defaultText ?? noteElement.defaultText;
}

export function defaultColorForShape(type: CanvasShapeType): string {
  return getCanvasElementExtension(type)?.defaultColor ?? noteElement.defaultColor;
}

export function defaultSizeForShape(type: CanvasShapeType) {
  return getCanvasElementExtension(type)?.defaultSize ?? noteElement.defaultSize;
}

export function minSizeForShape(type: CanvasShapeType) {
  return getCanvasElementExtension(type)?.minSize ?? { width: 80, height: 48 };
}

export function isValidCanvasShape(shape: CanvasShape): boolean {
  return getCanvasElementExtension(shape.type)?.isValid?.(shape) ?? true;
}

/**
 * JSON serialization for a shape, applying any element-specific quirks (text
 * strips its width/height). Defaults to a shallow copy.
 */
export function serializeCanvasShape(shape: CanvasShape): CanvasSerializedShape {
  return getCanvasElementExtension(shape.type)?.serialize?.(shape) ?? { ...shape };
}

/**
 * Whether a type persists an explicit width/height box. Font-scaled types
 * (text) auto-size to their content and store fontScale instead, so their box
 * is intentionally omitted from Yjs and snapshots.
 */
export function shapePersistsSize(type: CanvasShapeType): boolean {
  return getCanvasElementExtension(type)?.transform.resize !== "font";
}

/**
 * Whether a shape rasterizes on the host's canvas image layer (still images).
 * Canvas-only surfaces (sections) paint via their `paint` hook instead, so they
 * are not part of this layer.
 */
export function shapeRastersOnCanvas(shape: CanvasShape): boolean {
  const extension = getCanvasElementExtension(shape.type);
  return (
    extension?.surface === "dom+canvas" && (extension.rendersOnCanvas?.(shape) ?? true)
  );
}

/**
 * Whether a shape is rendered as a DOM element (an `<article>` custom element).
 * Canvas-only surfaces never are; `dom+canvas` shapes are in the DOM unless the
 * instance rasterizes on the canvas layer (a still image).
 */
export function shapeRendersInDom(shape: CanvasShape): boolean {
  const extension = getCanvasElementExtension(shape.type);
  if (!extension) return true;
  if (extension.surface === "canvas") return false;
  return !shapeRastersOnCanvas(shape);
}

/** The canvas-2d painter for a shape's type, if it paints on a canvas layer. */
export function shapePaintHook(type: CanvasShapeType) {
  return getCanvasElementExtension(type)?.paint;
}

/** Stacking group for a type (lower = further back). Defaults to 0. */
export function shapeZOrder(type: CanvasShapeType): number {
  return getCanvasElementExtension(type)?.zOrder ?? 0;
}
