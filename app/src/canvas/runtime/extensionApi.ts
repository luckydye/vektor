/**
 * The extension API: the contract every extension satisfies, and the
 * `CanvasElement.create()` / `CanvasTool.create()` factories for writing one.
 *
 * Imports nothing from `extensions/` — the built-ins import this, and a cycle
 * would leave the factory undefined while they initialise.
 */
import type { CanvasCollaborationFactory } from "#canvas/document/collaboration.ts";
import type {
  FreehandPoint,
  FreehandStroke,
  FreehandStrokeStyle,
} from "#canvas/render/freehand.ts";
import type { CanvasTile, CanvasTileClip, CanvasTileView } from "#canvas/render/tiles.ts";
import type { TranslationKey } from "#utils/lang.ts";

// ---------------------------------------------------------------------------
// from extensions/types.ts
// ---------------------------------------------------------------------------

// Extension and tool identifiers are deliberately open strings. The manager
// validates registrations at runtime; adding an extension must not require
// editing a core union first.
export type CanvasToolId = string;
export type CanvasShapeType = string;

export type CanvasShape = {
  id: string;
  type: CanvasShapeType;
  frame: CanvasFrame;
  style: CanvasBaseStyle;
  data: Record<string, unknown>;
  authorId?: string;
  locked?: boolean;
  updatedAt: number;
};

export type CanvasFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

type CanvasBaseStyle = {
  color: string;
};

export type CanvasSerializedShape =
  | CanvasShape
  | (Omit<CanvasShape, "frame"> & {
      frame: Omit<CanvasFrame, "height" | "width"> & {
        height?: number;
        width?: number;
      };
    });

export type CanvasSnapshot = {
  version: 1;
  shapes: CanvasSerializedShape[];
  strokes?: CanvasStrokeSnapshot[];
};

export type CanvasStrokeSnapshot = {
  id: string;
  points: FreehandPoint[];
  style: FreehandStrokeStyle;
  // Stamped library primitives retain this marker so they can expose shape
  // transform controls without changing freehand drawing behavior.
  kind?: "shape";
  rotation?: number;
  // See CanvasShape.authorId. Strokes use the same internal-only scope.
  authorId?: string;
  locked?: boolean;
  updatedAt: number;
};

export type CanvasStroke = FreehandStroke & {
  id: string;
  kind?: "shape";
  rotation?: number;
  // See CanvasShape.authorId. Strokes use the same internal-only scope.
  authorId?: string;
  locked?: boolean;
  updatedAt: number;
};

export type CanvasSize = {
  width: number;
  height: number;
};

export type CanvasPoint = { x: number; y: number };
export type CanvasRect = CanvasPoint & CanvasSize;

// ---------------------------------------------------------------------------
// Extension contract
//
// Each element TYPE is described by one `CanvasElementExtension`, mirroring the
// rich-text-editor's Tiptap extensions. The canvas host delegates all per-type
// behavior to these objects via the registry, instead of
// branching on `shape.type === "..."` inline. Optional fields describe
// capabilities; they do not trigger element-specific host fallbacks.
// ---------------------------------------------------------------------------

// Which render surface(s) an element uses. Most elements are plain DOM custom
// elements; images paint their pixels on a canvas layer but keep a DOM hit
// target (`dom+canvas`); sections are drawn entirely on a canvas layer.
type CanvasElementSurface = "dom" | "canvas" | "dom+canvas";

// Declarative transform capability, replacing the host's
// selectedTransformShape / selectedResizable* branches.
type CanvasElementTransform = {
  move: boolean;
  // "box" resizes width/height; "font" scales fontScale (text); "none" hides
  // the resize handle entirely.
  resize: "box" | "font" | "none";
  rotate: boolean;
  // Locks width/height ratio while resizing (image/video).
  aspectLocked?: boolean;
};

// How a shape enters edit mode after creation. The host either focuses the
// extension element itself or opens its registered painted-chrome editor.
type CanvasEditOnCreate = "element" | "chrome";

// Optional toolbar entry contributed by an element. The host merges these with
// its built-in tools (select/draw/shape).
export type CanvasElementTool = {
  id: CanvasToolId;
  label: TranslationKey;
  shortcut: string;
  icon: string;
};

// Pointer gestures are owned by the host after a tool starts one. This keeps
// capture, viewport coordinate conversion, coalesced pen samples, and cleanup
// consistent across freehand drawing and extension-provided tools.
export type CanvasPointerGestureSample = {
  event: PointerEvent;
  screen: CanvasPoint;
  world: CanvasPoint;
};

export type CanvasPointerGestureEvent = CanvasPointerGestureSample & {
  // PointerEvent.getCoalescedEvents(), converted through the same viewport
  // transform. Always contains at least the current event.
  samples: readonly CanvasPointerGestureSample[];
};

export type CanvasPointerGestureCancelReason =
  | "cancelled"
  | "escape"
  | "pointercancel"
  | "superseded"
  | "touch-gesture"
  | "unmount";

export interface CanvasPointerGestureHandlers {
  onMove?: (input: CanvasPointerGestureEvent, ctx: CanvasToolContext) => void;
  onEnd?: (input: CanvasPointerGestureEvent, ctx: CanvasToolContext) => void;
  onCancel?: (reason: CanvasPointerGestureCancelReason, ctx: CanvasToolContext) => void;
}

interface CanvasPointerGestureController {
  readonly pointerId: number;
  cancel: () => void;
}

// Services a canvas tool uses to act. The host owns gesture routing and the
// stroke/shape stores; tools own their interaction state and drive them.
export interface CanvasToolContext {
  penColor: () => string;
  viewportScale: () => number;
  // Begin an exclusive pointer gesture. Starting another gesture cancels the
  // current one; the host captures the pointer and routes move/end/cancel.
  beginPointerGesture: (
    event: PointerEvent,
    handlers: CanvasPointerGestureHandlers,
  ) => CanvasPointerGestureController;
  clearSelection: () => void;
  // Unfinished ink is rendered by the host but owned by the active tool.
  // Passing null clears it without committing it to the document.
  setActiveStroke: (stroke: FreehandStroke | null) => void;
  insertStroke: (stroke: CanvasStrokeSnapshot) => void;
  selectStroke: (id: string) => void;
  createElement: (type: CanvasShapeType, at: CanvasPoint) => void;
  setActiveTool: (tool: CanvasToolId) => void;
  /**
   * Current value of one of the active tool's declared `properties`.
   *
   * Falls back to the declared default, so a tool can read a property before
   * the reader has touched it.
   */
  property: <T extends CanvasToolPropertyValue>(id: string) => T;
}

export type CanvasToolPropertyValue = string | number;

/**
 * A control a tool contributes to the properties bar. Declarative so a tool need
 * not know the chrome is Solid. Values are per tool.
 */
export type CanvasToolProperty =
  | {
      // A row of colour swatches.
      kind: "swatches";
      id: string;
      label: TranslationKey;
      options: readonly string[];
      default: string;
    }
  | {
      // An icon toggle group — pen vs pencil, say.
      kind: "choice";
      id: string;
      label: TranslationKey;
      options: readonly { id: string; label: TranslationKey; icon: string }[];
      default: string;
    }
  | {
      // Preset stops, drawn as dots at their true relative size. World units,
      // so a size means the same thing at every zoom level.
      kind: "size";
      id: string;
      label: TranslationKey;
      options: readonly number[];
      default: number;
    };

// A canvas tool (draw, shape, …). The host dispatches an empty-canvas pointerdown
// for the active non-select tool to onPointerDown. `select` stays the engine
// default; element-creating tools (note/text/section) are derived from their
// element extension's `tool` + `create`.
export interface CanvasToolExtension {
  id: CanvasToolId;
  onPointerDown: (at: CanvasPoint, event: PointerEvent, ctx: CanvasToolContext) => void;
  /**
   * Toolbar entry. Omit for a tool with no button of its own — the shape tool is
   * reached through the shape library rather than the toolbar, but still wants a
   * shortcut.
   */
  toolbar?: {
    label: TranslationKey;
    icon: string;
  };
  /**
   * Key that selects this tool, e.g. "D". Registered as a `canvas:tool:<id>`
   * action, so the engine holds no per-tool keymap.
   */
  shortcut?: string;
  /**
   * Controls shown while this tool is active. The engine seeds each to its
   * `default`, renders the bar, and hands values back via
   * `CanvasToolContext.property`.
   */
  properties?: readonly CanvasToolProperty[];
}

/**
 * A context-menu entry an element contributes, rendered after the engine's own.
 * Asked for only when a single shape of that type is selected.
 */
interface CanvasContextMenuEntry {
  id: string;
  label: TranslationKey;
  icon: string;
  /** Renders in the destructive style, like Delete. */
  danger?: boolean;
  run: () => void;
}

export type CanvasInputKind = "paste" | "drop";

export interface CanvasInputHandlerContext {
  data: DataTransfer | null;
  at: () => CanvasPoint;
  phase: "preview" | "commit";
  command: (name: string, payload?: unknown) => unknown;
}

export interface CanvasInputHandler {
  priority: number;
  handle: (
    event: ClipboardEvent | DragEvent,
    context: CanvasInputHandlerContext,
  ) => boolean;
}

// An inline-edit session the host mounts (currently the document editor). Built
// by an extension's onActivate and handed to CanvasExtensionHost.beginEdit; the
// host owns the singleton editing slot.
export type CanvasEditSession = {
  shapeId: string;
  tag: string;
  className?: string;
  props: Record<string, unknown>;
  finish?: (element: HTMLElement | null) => void;
};

// Minimal host surface shared by every extension. Feature-specific controllers
// are registered as services by the registry runtime and remain typed inside
// their owning extension module.
export interface CanvasExtensionHost {
  spaceId: string;
  wasDragged: () => boolean;
  /**
   * Opens a collaboration session for an embedded document. Supplied by the app
   * shell; the canvas has no framework to read one from.
   */
  createCollaboration?: CanvasCollaborationFactory;
  beginEdit: (session: CanvasEditSession) => void;
  openUrl: (url: string) => void;
  dispatch: (name: string, detail: unknown) => void;
  service: <T>(key: symbol) => T;
}

// Engine services passed to a canvas-drawn element's paint() hook. The host
// owns layer setup (transform, clear) and coordinate geometry; the extension
// owns the shape's actual drawing and interaction regions.
export interface CanvasPaintHelpers {
  scale: number;
  // World→screen translation of the shared viewport transform.
  dx: number;
  dy: number;
  t: (key: TranslationKey) => string;
  // Section title chrome (shared geometry stays host-owned so hit-testing and
  // the inline title editor agree with what is painted).
  chromeTextColor: string;
  isEditingChrome: (id: string) => boolean;
  chromePosition: (shape: CanvasShape) => CanvasPoint;
  chromeSize: (shape: CanvasShape) => CanvasSize;
}

// Engine state handed to a DOM+canvas element's raster painter. The element
// owns its pixels, loading strategy, and placeholder; the
// host owns only the shared layer and viewport traversal.
export interface CanvasRasterPaintHelpers {
  scale: number;
  dx: number;
  dy: number;
  dpr: number;
  invalidate: () => void;
}

// Which part of a canvas-painted shape a point hit. "body" = the shape itself
// (images), "border"/"title" = a section's grabbable edge / editable title.
type CanvasHitRegion = "body" | "title" | "border";

// Geometry a canvas-painted element's hitTest needs. The host keeps the z-order
// (images above sections above the backdrop) and calls hitTest per shape.
export interface CanvasHitTestHelpers {
  worldToScreen: (point: CanvasPoint) => CanvasPoint;
  chromePosition: (shape: CanvasShape) => CanvasPoint;
  chromeSize: (shape: CanvasShape) => CanvasSize;
}

export interface CanvasElementExtension {
  type: CanvasShapeType;
  defaults: {
    size: CanvasSize;
    minSize: CanvasSize;
    style: CanvasBaseStyle;
    data: Record<string, unknown>;
  };
  isValid?: (shape: CanvasShape) => boolean;
  creation?: {
    /**
     * Builds the shape. `ctx.color` is the active toolbar swatch for types that
     * declare a `palette`, so a factory can honour it without reaching into the
     * host.
     */
    create: (at: CanvasPoint, ctx: { color?: string }) => CanvasShape;
    tool?: CanvasElementTool;
    editOnCreate?: CanvasEditOnCreate;
    doubleClick?: boolean;
    palette?: readonly string[];
  };
  render: {
    surface: CanvasElementSurface;
    tag?: string;
    rasterize?: (shape: CanvasShape) => boolean;
    paint?: (
      ctx: CanvasRenderingContext2D,
      shape: CanvasShape,
      helpers: CanvasPaintHelpers,
    ) => void;
    paintRaster?: (
      ctx: CanvasRenderingContext2D,
      shape: CanvasShape,
      helpers: CanvasRasterPaintHelpers,
    ) => void;
    /**
     * Zoom-relative raster content. `tiles` runs every frame and must return
     * already-rasterized work; `refresh` fires when the viewport outgrows it.
     * Prefer `paintRaster` unless one resolution genuinely will not do.
     */
    tiles?: {
      tiles: (
        shape: CanvasShape,
        view: CanvasTileView,
      ) => readonly (CanvasTile | null)[] | null;
      refresh?: (
        shape: CanvasShape,
        view: CanvasTileView,
        invalidate: () => void,
      ) => void;
      /** Optional clip in shape-local coordinates; rotation in radians. */
      clip?: (shape: CanvasShape) => CanvasTileClip | null;
    };
    hitTest?: (
      shape: CanvasShape,
      point: CanvasPoint,
      helpers: CanvasHitTestHelpers,
    ) => CanvasHitRegion | null;
    article?: {
      background?: boolean;
      style?: (shape: CanvasShape) => Record<string, string>;
    };
    chrome?: {
      editorTag: string;
      position: (
        shape: CanvasShape,
        helpers: { scale: number; worldToScreen: (point: CanvasPoint) => CanvasPoint },
      ) => CanvasPoint;
      size: (
        shape: CanvasShape,
        helpers: { scale: number; t: (key: TranslationKey) => string },
      ) => CanvasSize;
    };
  };
  behavior: {
    transform: CanvasElementTransform;
    zOrder?: number;
    editableBody?: boolean;
    measurement?: {
      fallback?: (shape: CanvasShape) => CanvasSize;
      normalize?: (
        shape: CanvasShape,
        size: Partial<CanvasSize>,
      ) => Partial<CanvasSize> | null;
    };
    container?: {
      containsBounds: (container: CanvasShape, bounds: CanvasRect) => boolean;
      containsPoint: (container: CanvasShape, point: CanvasPoint) => boolean;
    };
  };
  storage?: {
    parseData?: (
      data: Record<string, unknown>,
      context: { currentOrigin: string; defaultSpaceId: string },
    ) => Record<string, unknown>;
    serializeData?: (data: Record<string, unknown>) => Record<string, unknown>;
  };
  events?: {
    data?: (shape: CanvasShape, host: CanvasExtensionHost) => unknown;
    activate?: (shape: CanvasShape, host: CanvasExtensionHost, event: MouseEvent) => void;
    open?: (shape: CanvasShape, host: CanvasExtensionHost, event: Event) => void;
    prepare?: {
      key: (shape: CanvasShape, host: CanvasExtensionHost) => string | null;
      run: (shape: CanvasShape, host: CanvasExtensionHost) => void;
    };
  };
  input?: Partial<
    Record<CanvasInputKind, CanvasInputHandler | readonly CanvasInputHandler[]>
  >;
  /**
   * Extra context-menu entries for a single selected shape of this type.
   *
   * Called while the menu is opening, so it may read live state; return an empty
   * array when there is nothing to offer.
   */
  contextMenu?: (
    shape: CanvasShape,
    host: CanvasExtensionHost,
  ) => readonly CanvasContextMenuEntry[];
}

// ---------------------------------------------------------------------------
// from extensions/define.ts
// ---------------------------------------------------------------------------

/** `this` inside an extension's config methods. */
interface ExtensionThis<TOptions, TStorage> {
  /** The extension's own name, so config never has to hard-code it. */
  readonly name: string;
  readonly options: TOptions;
  readonly storage: TStorage;
}

type Method<TOptions, TStorage, TReturn> = (
  this: ExtensionThis<TOptions, TStorage>,
) => TReturn;

type Element = CanvasElementExtension;

interface CanvasElementConfig<TOptions, TStorage> {
  /**
   * The element's type name — this is what `shape.type` holds, the same way a
   * Tiptap node's `name` is its schema type.
   */
  name: string;

  /**
   * Per-instance configuration, overridable with `.configure()`.
   *
   * Anything a consumer might reasonably want to change — a palette, a default
   * size — belongs here rather than in a module-level constant.
   */
  addOptions?: (this: { name: string }) => TOptions;

  /**
   * Mutable per-extension state, reachable as `this.storage`.
   *
   * The home for what would otherwise become a module-level singleton.
   */
  addStorage?: (this: { name: string; options: TOptions }) => TStorage;

  addDefaults: Method<TOptions, TStorage, Element["defaults"]>;
  addRender: Method<TOptions, TStorage, Element["render"]>;
  addBehavior: Method<TOptions, TStorage, Element["behavior"]>;
  addCreation?: Method<TOptions, TStorage, NonNullable<Element["creation"]>>;
  addEvents?: Method<TOptions, TStorage, NonNullable<Element["events"]>>;
  addInput?: Method<TOptions, TStorage, NonNullable<Element["input"]>>;

  /** Behaviour rather than config, so these keep their names and get `this`. */
  isValid?: (this: ExtensionThis<TOptions, TStorage>, shape: CanvasShape) => boolean;
  contextMenu?: (
    this: ExtensionThis<TOptions, TStorage>,
    shape: CanvasShape,
    host: CanvasExtensionHost,
  ) => readonly CanvasContextMenuEntry[];
  /**
   * Persistence for the element's `data`, the canvas equivalent of Tiptap's
   * `parseHTML` / `renderHTML` — canvas documents hold JSON, not HTML.
   */
  parseData?: (
    this: ExtensionThis<TOptions, TStorage>,
    data: Record<string, unknown>,
    context: { currentOrigin: string; defaultSpaceId: string },
  ) => Record<string, unknown>;
  serializeData?: (
    this: ExtensionThis<TOptions, TStorage>,
    data: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/** A defined element: the runtime extension, plus the authoring affordances. */
type DefinedCanvasElement<TOptions, TStorage> = CanvasElementExtension & {
  readonly name: string;
  readonly options: TOptions;
  readonly storage: TStorage;
  /** A copy with options merged over the defaults. */
  configure: (options?: Partial<TOptions>) => DefinedCanvasElement<TOptions, TStorage>;
  /** A copy with config overridden — the subclassing escape hatch. */
  extend: <TNextOptions = TOptions, TNextStorage = TStorage>(
    config: Partial<CanvasElementConfig<TNextOptions, TNextStorage>>,
  ) => DefinedCanvasElement<TNextOptions, TNextStorage>;
};

function buildElement<TOptions, TStorage>(
  config: CanvasElementConfig<TOptions, TStorage>,
  overrides: Partial<TOptions>,
): DefinedCanvasElement<TOptions, TStorage> {
  const name = config.name;
  const base = (config.addOptions?.call({ name }) ?? {}) as TOptions;
  const options = { ...base, ...overrides } as TOptions;
  const storage = (config.addStorage?.call({ name, options }) ?? {}) as TStorage;
  const self: ExtensionThis<TOptions, TStorage> = { name, options, storage };

  // Config methods are resolved once, here, so the engine reads plain fields and
  // never pays for a call per frame.
  const element = {
    type: name,
    defaults: config.addDefaults.call(self),
    render: config.addRender.call(self),
    behavior: config.addBehavior.call(self),
    creation: config.addCreation?.call(self),
    events: config.addEvents?.call(self),
    input: config.addInput?.call(self),
    isValid:
      config.isValid && ((shape: CanvasShape) => config.isValid?.call(self, shape)),
    contextMenu:
      config.contextMenu &&
      ((shape: CanvasShape, host: CanvasExtensionHost) =>
        config.contextMenu?.call(self, shape, host) ?? []),
    storage:
      config.parseData || config.serializeData
        ? {
            parseData:
              config.parseData &&
              ((
                data: Record<string, unknown>,
                ctx: {
                  currentOrigin: string;
                  defaultSpaceId: string;
                },
              ) => config.parseData?.call(self, data, ctx) ?? data),
            serializeData:
              config.serializeData &&
              ((data: Record<string, unknown>) =>
                config.serializeData?.call(self, data) ?? data),
          }
        : undefined,
  } as CanvasElementExtension;

  return Object.assign(element, {
    name,
    options,
    storage,
    configure: (next: Partial<TOptions> = {}) =>
      buildElement(config, { ...overrides, ...next }),
    extend: <TNextOptions = TOptions, TNextStorage = TStorage>(
      patch: Partial<CanvasElementConfig<TNextOptions, TNextStorage>>,
    ) =>
      buildElement(
        { ...config, ...patch } as unknown as CanvasElementConfig<
          TNextOptions,
          TNextStorage
        >,
        overrides as unknown as Partial<TNextOptions>,
      ),
  }) as DefinedCanvasElement<TOptions, TStorage>;
}

export const CanvasElement = {
  create<TOptions = Record<string, never>, TStorage = Record<string, never>>(
    config: CanvasElementConfig<TOptions, TStorage>,
  ): DefinedCanvasElement<TOptions, TStorage> {
    return buildElement(config, {});
  },
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface CanvasToolConfig<TOptions, TStorage> {
  name: string;
  addOptions?: (this: { name: string }) => TOptions;
  addStorage?: (this: { name: string; options: TOptions }) => TStorage;
  /** Toolbar entry. Omit for a tool reached some other way — see the shape tool. */
  toolbar?: CanvasToolExtension["toolbar"];
  shortcut?: string;
  addProperties?: Method<TOptions, TStorage, readonly CanvasToolProperty[]>;
  onPointerDown: (
    this: ExtensionThis<TOptions, TStorage>,
    at: CanvasPoint,
    event: PointerEvent,
    ctx: CanvasToolContext,
  ) => void;
}

type DefinedCanvasTool<TOptions, TStorage> = CanvasToolExtension & {
  readonly name: string;
  readonly options: TOptions;
  readonly storage: TStorage;
  configure: (options?: Partial<TOptions>) => DefinedCanvasTool<TOptions, TStorage>;
};

function buildTool<TOptions, TStorage>(
  config: CanvasToolConfig<TOptions, TStorage>,
  overrides: Partial<TOptions>,
): DefinedCanvasTool<TOptions, TStorage> {
  const name = config.name;
  const base = (config.addOptions?.call({ name }) ?? {}) as TOptions;
  const options = { ...base, ...overrides } as TOptions;
  const storage = (config.addStorage?.call({ name, options }) ?? {}) as TStorage;
  const self: ExtensionThis<TOptions, TStorage> = { name, options, storage };

  const tool: CanvasToolExtension = {
    id: name,
    toolbar: config.toolbar,
    shortcut: config.shortcut,
    properties: config.addProperties?.call(self),
    onPointerDown: (at, event, ctx) => config.onPointerDown.call(self, at, event, ctx),
  };

  return Object.assign(tool, {
    name,
    options,
    storage,
    configure: (next: Partial<TOptions> = {}) =>
      buildTool(config, { ...overrides, ...next }),
  }) as DefinedCanvasTool<TOptions, TStorage>;
}

export const CanvasTool = {
  create<TOptions = Record<string, never>, TStorage = Record<string, never>>(
    config: CanvasToolConfig<TOptions, TStorage>,
  ): DefinedCanvasTool<TOptions, TStorage> {
    return buildTool(config, {});
  },
};
