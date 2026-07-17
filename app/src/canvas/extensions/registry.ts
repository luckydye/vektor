import type { TranslationKey } from "#utils/lang.ts";
import { documentLinkElement } from "./documentLink.ts";
import { drawTool } from "./drawing.ts";
import { figmaPasteInput } from "./figma.ts";
import { fileElement } from "./files.ts";
import { canvasClipboardInput } from "./inputs.ts";
import { linkElement } from "./link.ts";
import { audioElement, imageElement, videoElement } from "./media.ts";
import { noteElement } from "./note.ts";
import {
  type CanvasExtensionRuntimeOptions,
  createCanvasExtensionRuntime,
} from "./runtime.ts";
import { sectionElement } from "./section.ts";
import { shapeTool } from "./shape.ts";
import { textElement } from "./text.ts";
import type {
  CanvasElementExtension,
  CanvasElementTool,
  CanvasInputHandler,
  CanvasInputHandlerContext,
  CanvasInputKind,
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasTool,
  CanvasToolExtension,
} from "./types.ts";

export type { CanvasElementContext } from "./CanvasElementBase.ts";
export {
  activeDrawStrokeMode,
  addCanvasDrawingPoint,
  addCanvasDrawingPoints,
  type CanvasDrawingSession,
  cloneFreehandPoint,
  createCanvasInkRenderer,
  createCanvasSelectionRenderer,
  createStrokeMap,
  DRAW_STROKE_MODES,
  type DrawStrokeMode,
  drawCanvasStrokes,
  FREEHAND_STYLE,
  finishCanvasDrawingStroke,
  hitTestCanvasStroke,
  PEN_COLORS,
  renderCanvasInk,
  renderCanvasInkOverlay,
  renderCanvasStrokes,
  type CanvasSelectionSnapshot,
  startCanvasDrawingStroke,
  strokeStyleFromUnknown,
  toCanvasStroke,
} from "./drawing.ts";
export {
  activeShapeId,
  type CanvasShapeLibraryItem,
  SHAPE_LIBRARY,
  setActiveShapeId,
} from "./shape.ts";

export const builtInCanvasElementExtensions = [
  noteElement,
  textElement,
  imageElement,
  videoElement,
  audioElement,
  fileElement,
  documentLinkElement,
  linkElement,
  sectionElement,
] satisfies readonly CanvasElementExtension[];

export type CanvasColorPalette = {
  type: CanvasShapeType;
  label: TranslationKey;
  palette: readonly string[];
};

export type CanvasExtensionManagerOptions = {
  elements?: readonly CanvasElementExtension[];
  tools?: readonly CanvasToolExtension[];
  inputs?: Partial<Record<CanvasInputKind, readonly CanvasInputHandler[]>>;
};

export class CanvasExtensionManager {
  readonly #elements = new Map<CanvasShapeType, CanvasElementExtension>();
  readonly #tools = new Map<CanvasTool, CanvasToolExtension>();
  readonly #inputs = new Map<CanvasInputKind, CanvasInputHandler[]>();

  constructor(options: CanvasExtensionManagerOptions = {}) {
    for (const extension of options.elements ?? []) this.registerElement(extension);
    for (const tool of options.tools ?? []) this.registerTool(tool);
    for (const kind of ["paste", "drop"] as const) {
      for (const handler of options.inputs?.[kind] ?? [])
        this.registerInput(kind, handler);
    }
  }

  registerElement(extension: CanvasElementExtension) {
    if (this.#elements.has(extension.type)) {
      throw new Error(
        `Canvas element extension is already registered: ${extension.type}`,
      );
    }
    const toolId = extension.creation?.tool?.id;
    if (toolId && this.#tools.has(toolId)) {
      throw new Error(`Canvas tool is already registered: ${toolId}`);
    }
    this.#elements.set(extension.type, extension);
    for (const kind of ["paste", "drop"] as const) {
      const contribution = extension.input?.[kind];
      if (!contribution) continue;
      const handlers = Array.isArray(contribution) ? contribution : [contribution];
      for (const handler of handlers) this.registerInput(kind, handler);
    }
    if (toolId) {
      this.#tools.set(toolId, {
        id: toolId,
        onPointerDown: (at, _event, context) => context.createElement(extension.type, at),
      });
    }
    return this;
  }

  registerTool(tool: CanvasToolExtension) {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Canvas tool is already registered: ${tool.id}`);
    }
    this.#tools.set(tool.id, tool);
    return this;
  }

  registerInput(kind: CanvasInputKind, handler: CanvasInputHandler) {
    const handlers = this.#inputs.get(kind) ?? [];
    handlers.push(handler);
    handlers.sort((left, right) => right.priority - left.priority);
    this.#inputs.set(kind, handlers);
    return this;
  }

  handleInput(
    kind: CanvasInputKind,
    event: ClipboardEvent | DragEvent,
    context: CanvasInputHandlerContext,
  ) {
    return (this.#inputs.get(kind) ?? []).some((handler) =>
      handler.handle(event, context),
    );
  }

  has(type: unknown): type is CanvasShapeType {
    return typeof type === "string" && this.#elements.has(type);
  }

  get(type: CanvasShapeType) {
    const extension = this.#elements.get(type);
    if (!extension)
      throw new Error(`Canvas element extension is not registered: ${type}`);
    return extension;
  }

  elementTools(): CanvasElementTool[] {
    return [...this.#elements.values()]
      .map((extension) => extension.creation?.tool)
      .filter((tool): tool is CanvasElementTool => Boolean(tool));
  }

  colorPalettes(): CanvasColorPalette[] {
    return [...this.#elements.values()].flatMap((extension) => {
      const creation = extension.creation;
      if (!creation?.palette || !creation.tool) return [];
      return [
        {
          type: extension.type,
          label: creation.tool.label,
          palette: creation.palette,
        },
      ];
    });
  }

  doubleClickType() {
    return [...this.#elements.values()].find(
      (extension) => extension.creation?.doubleClick,
    )?.type;
  }

  tool(id: CanvasTool) {
    return this.#tools.get(id);
  }

  isValid(shape: CanvasShape) {
    return this.get(shape.type).isValid?.(shape) ?? true;
  }

  persistsSize(type: CanvasShapeType) {
    return this.get(type).behavior.transform.resize !== "font";
  }

  serialize(shape: CanvasShape): CanvasSerializedShape {
    const extension = this.get(shape.type);
    const serialized = {
      ...shape,
      data: extension.storage?.serializeData?.(shape.data) ?? { ...shape.data },
    };
    if (this.persistsSize(shape.type)) return serialized;
    const { width: _width, height: _height, ...frame } = shape.frame;
    return { ...serialized, frame } as CanvasSerializedShape;
  }

  rasters(shape: CanvasShape) {
    const render = this.get(shape.type).render;
    return render.surface === "dom+canvas" && (render.rasterize?.(shape) ?? true);
  }

  rendersInDom(shape: CanvasShape) {
    return this.get(shape.type).render.surface !== "canvas" && !this.rasters(shape);
  }

  paint(type: CanvasShapeType) {
    return this.get(type).render.paint;
  }

  zOrder(type: CanvasShapeType) {
    return this.get(type).behavior.zOrder ?? 0;
  }

  createRuntime(options: Omit<CanvasExtensionRuntimeOptions, "sizeFor">) {
    return createCanvasExtensionRuntime({
      ...options,
      sizeFor: (type) => this.get(type).defaults.size,
    });
  }
}

export function createCanvasExtensionManager(
  options: CanvasExtensionManagerOptions = {},
) {
  return new CanvasExtensionManager({
    elements: [...builtInCanvasElementExtensions, ...(options.elements ?? [])],
    tools: [drawTool, shapeTool, ...(options.tools ?? [])],
    inputs: {
      paste: [canvasClipboardInput, figmaPasteInput, ...(options.inputs?.paste ?? [])],
      drop: options.inputs?.drop,
    },
  });
}
