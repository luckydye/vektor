import { documentLinkElement } from "./documentLink.ts";
import { fileElement } from "./files.ts";
import { linkElement } from "./link.ts";
import { audioElement, imageElement, videoElement } from "./media.ts";
import { noteElement } from "./note.ts";
import { sectionElement } from "./section.ts";
import { textElement } from "./text.ts";
import type {
  CanvasElementExtension,
  CanvasElementTool,
  CanvasShape,
  CanvasShapeType,
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

/** All registered extensions, in registration order. */
export function canvasElementExtensions(): readonly CanvasElementExtension[] {
  return elementExtensions;
}

/** Toolbar entries contributed by extensions (note/text/section), in order. */
export function canvasElementTools(): CanvasElementTool[] {
  return elementExtensions
    .map((extension) => extension.tool)
    .filter((tool): tool is CanvasElementTool => Boolean(tool));
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
