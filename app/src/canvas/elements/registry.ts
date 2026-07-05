import { documentLinkElement } from "./documentLink.ts";
import { fileElement } from "./files.ts";
import { linkElement } from "./link.ts";
import { imageElement, videoElement } from "./media.ts";
import { noteElement } from "./note.ts";
import { textElement } from "./text.ts";
import type {
  CanvasElementDefinition,
  CanvasElementType,
  CanvasShape,
  CanvasShapeType,
} from "./types.ts";

const elementDefinitions = [
  noteElement,
  textElement,
  imageElement,
  videoElement,
  fileElement,
  documentLinkElement,
  linkElement,
] satisfies CanvasElementDefinition[];

const definitionsByType = new Map<CanvasElementType, CanvasElementDefinition>(
  elementDefinitions.map((definition) => [definition.type, definition]),
);

export function isCanvasShapeType(value: unknown): value is CanvasShapeType {
  return (
    value === "section" ||
    (typeof value === "string" && definitionsByType.has(value as CanvasElementType))
  );
}

export function getCanvasElementDefinition(
  type: CanvasShapeType,
): CanvasElementDefinition | undefined {
  if (type === "section") return undefined;
  return definitionsByType.get(type);
}

export function defaultTextForShape(type: CanvasShapeType): string {
  if (type === "section") return "Section";
  return getCanvasElementDefinition(type)?.defaultText ?? "Note";
}

export function defaultColorForShape(type: CanvasShapeType): string {
  if (type === "section") return "rgba(255, 255, 255, 0.02)";
  return getCanvasElementDefinition(type)?.defaultColor ?? noteElement.defaultColor;
}

export function defaultSizeForShape(type: CanvasShapeType) {
  if (type === "section") return { width: 560, height: 340 };
  return getCanvasElementDefinition(type)?.defaultSize ?? noteElement.defaultSize;
}

export function minSizeForShape(type: CanvasShapeType) {
  if (type === "section") return { width: 240, height: 160 };
  return getCanvasElementDefinition(type)?.minSize ?? { width: 80, height: 48 };
}

export function isValidCanvasShape(shape: CanvasShape): boolean {
  return getCanvasElementDefinition(shape.type)?.isValid?.(shape) ?? true;
}
