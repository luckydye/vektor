/**
 * Everything the canvas ships with, in its three roles: elements (a thing on the
 * canvas), tools (a pointer mode), inputs (paste/drop handlers). Adding a
 * built-in means touching only this file — `runtime/registry.ts` reads these
 * lists and knows nothing else about the folder.
 *
 * `documentEditor`, `twitterEmbed` and `twitterWidgets` are not extensions;
 * they are supporting pieces.
 */
import { CanvasDocumentLink } from "#canvas/extensions/documentLink.ts";
import { DrawTool } from "#canvas/extensions/drawTool.ts";
import { figmaPasteInput } from "#canvas/extensions/figma.ts";
import { CanvasFile } from "#canvas/extensions/files.ts";
import { canvasClipboardInput } from "#canvas/extensions/inputs.ts";
import { CanvasLink } from "#canvas/extensions/link.ts";
import { CanvasAudio, CanvasImage, CanvasVideo } from "#canvas/extensions/media.ts";
import { CanvasModel } from "#canvas/extensions/model.ts";
import { Note } from "#canvas/extensions/note.ts";
import { CanvasSection } from "#canvas/extensions/section.ts";
import { ShapeTool } from "#canvas/extensions/shape.ts";
import { CanvasText } from "#canvas/extensions/text.ts";
import type {
  CanvasElementExtension,
  CanvasInputHandler,
  CanvasInputKind,
  CanvasToolExtension,
} from "#canvas/runtime/extensionApi.ts";

/**
 * Element types, in registration order.
 *
 * Order here does not decide paint order — that is `behavior.zOrder`, which is
 * why sections can be registered late and still draw behind everything.
 */
export const builtInElements = [
  Note,
  CanvasText,
  CanvasImage,
  CanvasVideo,
  CanvasAudio,
  CanvasFile,
  CanvasModel,
  CanvasDocumentLink,
  CanvasLink,
  CanvasSection,
] satisfies readonly CanvasElementExtension[];

/**
 * Tools that are not tied to creating one element.
 *
 * The note/text/section tools are absent on purpose: an element that declares
 * `creation.tool` gets one synthesised by the registry.
 */
export const builtInTools = [
  DrawTool,
  ShapeTool,
] satisfies readonly CanvasToolExtension[];

/** Paste and drop handlers. Highest priority wins; see `CanvasInputHandler`. */
export const builtInInputs = {
  paste: [canvasClipboardInput, figmaPasteInput],
} satisfies Partial<Record<CanvasInputKind, readonly CanvasInputHandler[]>>;
