/**
 * The canvas library — the public surface for browser code: mounting a canvas,
 * writing an extension, registering one. Everything else under `canvas/` is
 * internal and may be rearranged.
 *
 * Only add an export when something imports it. This file was once 105 exports
 * of which five were used.
 *
 * Layers, each importing only from the ones after it: `render/`, `document/`,
 * `runtime/` (the canvas itself), `extensions/` (what ships), `ui/` (chrome).
 *
 * `ui/` makes this file client-only — it reaches `@solidjs/router`, which has no
 * server build. Server code imports `#canvas/document/index.ts`.
 *
 * Do not merge `runtime/extensionApi.ts` into `runtime/registry.ts`: ten of the
 * modules the registry imports call `CanvasElement.create()` at module top
 * level, and ESM evaluates imports before the module body, so the merged file
 * would throw `Cannot access 'CanvasElement' before initialization`.
 */

// --- document (also the server-safe entry) ---------------------------------
export * from "#canvas/document/index.ts";
// --- what ships ------------------------------------------------------------
export {
  builtInElements,
  builtInInputs,
  builtInTools,
} from "#canvas/extensions/index.ts";
// No caller yet, but `render.tiles` leaks without it: nothing else can free a
// replaced tile's cached surface.
export { releaseTileSurface } from "#canvas/render/tiles.ts";
// --- writing an extension --------------------------------------------------
// `HostElement`, not `HTMLElement`: these stay importable during SSR.
export {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  type CanvasElementContext,
  CanvasRichTextElement,
  dragOnPointerDown,
  HostElement,
} from "#canvas/runtime/elementBase.ts";
// For extensions written without the factory, plus what app code touches.
export type {
  CanvasElementExtension,
  CanvasSerializedShape,
  CanvasShape,
  CanvasStrokeSnapshot,
  CanvasToolExtension,
  CanvasToolId,
} from "#canvas/runtime/extensionApi.ts";
// Shaped like Tiptap's `Node.create()` — `addX()` methods, `this.options`,
// `.configure()`. Shape only; a Tiptap Node cannot be registered here.
export { CanvasElement, CanvasTool } from "#canvas/runtime/extensionApi.ts";
// --- registering extensions (starts from the built-ins) --------------------
export {
  CanvasExtensionManager,
  createCanvasExtensionManager,
} from "#canvas/runtime/registry.ts";
// --- mounting --------------------------------------------------------------
export { Canvas } from "#canvas/ui/Canvas.tsx";
export { CanvasHostElement, canvasHostTag } from "#canvas/ui/CanvasHostElement.ts";
