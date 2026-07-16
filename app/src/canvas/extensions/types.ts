import type { TranslationKey } from "#utils/lang.ts";
import type {
  FreehandPoint,
  FreehandStroke,
  FreehandStrokeStyle,
} from "../viewport/index.ts";

// Extension and tool identifiers are deliberately open strings. The manager
// validates registrations at runtime; adding an extension must not require
// editing a core union first.
export type CanvasTool = string;
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

export type CanvasBaseStyle = {
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
// rich-text-editor's Tiptap extensions. Canvas.vue is a host/engine that
// delegates all per-type behavior to these objects via the registry, instead of
// branching on `shape.type === "..."` inline. Optional fields describe
// capabilities; they do not trigger element-specific host fallbacks.
// ---------------------------------------------------------------------------

// Which render surface(s) an element uses. Most elements are plain DOM custom
// elements; images paint their pixels on a canvas layer but keep a DOM hit
// target (`dom+canvas`); sections are drawn entirely on a canvas layer.
export type CanvasElementSurface = "dom" | "canvas" | "dom+canvas";

// Declarative transform capability, replacing the host's
// selectedTransformShape / selectedResizable* branches.
export type CanvasElementTransform = {
  move: boolean;
  // "box" resizes width/height; "font" scales fontScale (text); "none" hides
  // the resize handle entirely.
  resize: "box" | "font" | "none";
  rotate: boolean;
  // Locks width/height ratio while resizing (image/video).
  aspectLocked?: boolean;
};

// Context handed to `create()` so factories can read active toolbar state (the
// note/section color pickers) without reaching into the host.
export type CanvasElementCreateContext = {
  color?: string;
};

// How a shape enters edit mode after creation. The host either focuses the
// extension element itself or opens its registered painted-chrome editor.
export type CanvasEditOnCreate = "element" | "chrome";

// Optional toolbar entry contributed by an element. The host merges these with
// its built-in tools (select/draw/shape).
export type CanvasElementTool = {
  id: CanvasTool;
  label: TranslationKey;
  shortcut: string;
  icon: string;
};

// Services a canvas tool uses to act. The host owns the stroke/shape stores and
// the freehand/drag engine; tools drive them.
export interface CanvasToolContext {
  penColor: () => string;
  // Begin a streaming freehand stroke from this pointerdown (engine-managed).
  startFreehand: (event: PointerEvent) => void;
  insertStroke: (stroke: CanvasStrokeSnapshot) => void;
  selectStroke: (id: string) => void;
  createElement: (type: CanvasShapeType, at: CanvasPoint) => void;
  setActiveTool: (tool: CanvasTool) => void;
}

// A canvas tool (draw, shape, …). The host dispatches an empty-canvas pointerdown
// for the active non-select tool to onPointerDown. `select` stays the engine
// default; element-creating tools (note/text/section) are derived from their
// element extension's `tool` + `create`.
export interface CanvasToolExtension {
  id: CanvasTool;
  onPointerDown: (at: CanvasPoint, event: PointerEvent, ctx: CanvasToolContext) => void;
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
export type CanvasHitRegion = "body" | "title" | "border";

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
    create: (at: CanvasPoint, ctx: CanvasElementCreateContext) => CanvasShape;
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
}
