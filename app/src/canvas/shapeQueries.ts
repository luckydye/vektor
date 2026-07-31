import type { CanvasExtensionManager } from "./extensions/registry.ts";
import type { CanvasShape } from "./extensions/types.ts";

/**
 * Questions about a shape that only its extension can answer.
 *
 * The extension manager is created per canvas rather than being a module
 * singleton, so it is passed in.
 */

/** Inline CSS for a shape's article wrapper. */
export function articleStyle(
  shape: CanvasShape,
  extensions: CanvasExtensionManager,
): Record<string, string> {
  const extension = extensions.get(shape.type);
  const frame = shape.frame;
  const style: Record<string, string> = {
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    transform: `rotate(${frame.rotation}deg)`,
  };
  // Font-resized shapes size themselves from their content; writing a box would
  // fight the measurement.
  if (extension.behavior.transform.resize !== "font") {
    style.width = `${frame.width}px`;
    style.height = `${frame.height}px`;
  }
  if (extension.render.article?.background !== false) {
    style.background = shape.style.color;
  }
  return { ...style, ...extension.render.article?.style?.(shape) };
}

export function editorTagForShape(
  shape: CanvasShape,
  extensions: CanvasExtensionManager,
): string | undefined {
  return extensions.get(shape.type).render.chrome?.editorTag;
}

/** A container accepts other shapes dropped onto it — a section, for instance. */
export function isContainerShape(
  shape: CanvasShape | undefined,
  extensions: CanvasExtensionManager,
): boolean {
  return Boolean(shape && extensions.get(shape.type).behavior.container);
}

/**
 * Whether the canvas should swallow native pointer events over this shape.
 *
 * A shape with an editable body (a text note) needs its own pointer handling;
 * everything else lets the canvas drive selection and dragging.
 */
export function suppressesNativePointer(
  shape: CanvasShape,
  extensions: CanvasExtensionManager,
): boolean {
  return !extensions.get(shape.type).behavior.editableBody;
}

/**
 * Whether the browser's own find-in-page can see this shape's content.
 *
 * Only text-bearing shapes render their content as DOM text; the rest are
 * painted, so the browser has nothing to match against.
 */
export function isBrowserFindTarget(shape: CanvasShape): boolean {
  return shape.type === "text" || shape.type === "note";
}
