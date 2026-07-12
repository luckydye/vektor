import type * as Y from "yjs";
import type { TranslationKey } from "#utils/lang.ts";
import type {
  FreehandPoint,
  FreehandStroke,
  FreehandStrokeStyle,
} from "#viewport/index.ts";

export type CanvasTool = "select" | "draw" | "note" | "text" | "section" | "shape";
export type CanvasElementType =
  | "note"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "document"
  | "link";
export type CanvasShapeType = CanvasElementType | "section";

export type CanvasShape = {
  id: string;
  type: CanvasShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  // Clockwise degrees around the shape centre. Old documents omit this and
  // are normalized to zero when read.
  rotation: number;
  // Proportional scale for text shapes (1 = intrinsic size). Text auto-fits its
  // content, so resizing scales the font rather than a fixed box. Other shape
  // types size via width/height and leave this at 1.
  fontScale?: number;
  text: string;
  color: string;
  src?: string;
  alt?: string;
  docAddress?: string;
  // Internal-only user scope for element creators (for example, cosmetics or
  // stickers): set this to the creating user's id. Canvas UI deliberately does
  // not expose a control for it. Shared elements omit the field.
  authorId?: string;
  // Locked elements stay visible but cannot be selected or transformed until
  // explicitly unlocked from their hover control.
  locked?: boolean;
  updatedAt: number;
};

export type CanvasSerializedShape =
  | CanvasShape
  | (Omit<CanvasShape, "height" | "width"> & {
      type: "text";
      height?: number;
      width?: number;
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

// ---------------------------------------------------------------------------
// Extension contract
//
// Each element TYPE is described by one `CanvasElementExtension`, mirroring the
// rich-text-editor's Tiptap extensions. Canvas.vue is a host/engine that
// delegates all per-type behavior to these objects via the registry, instead of
// branching on `shape.type === "..."` inline. New fields are optional so the
// contract can be populated incrementally; the host falls back to its built-in
// behavior for anything an extension does not (yet) provide.
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

// Optional toolbar entry contributed by an element. The host merges these with
// its built-in tools (select/draw/shape).
export type CanvasElementTool = {
  id: CanvasTool;
  label: TranslationKey;
  shortcut: string;
  icon: string;
};

// Reads a raw attribute from either a Yjs map or a plain serialized object.
export type CanvasShapeAttrReader = (key: string) => unknown;

// Engine services passed to a canvas-drawn element's paint() hook. The host
// owns the layer setup (transform, clear), image caching, selection overlays,
// and the geometry it shares with hit-testing / the title-edit overlay; the
// hook receives what it needs to draw the shape's own content.
export interface CanvasPaintHelpers {
  scale: number;
  // World→screen translation of the shared viewport transform.
  dx: number;
  dy: number;
  t: (key: TranslationKey) => string;
  // Section title chrome (shared geometry stays host-owned so hit-testing and
  // the inline title editor agree with what is painted).
  sectionTitleColor: string;
  isEditingSectionTitle: (id: string) => boolean;
  sectionTitlePosition: (shape: CanvasShape) => CanvasPoint;
  sectionTitleSize: (shape: CanvasShape) => CanvasSize;
}

export interface CanvasElementExtension {
  // --- metadata ---
  type: CanvasShapeType;
  defaultText: string;
  defaultColor: string;
  defaultSize: CanvasSize;
  minSize: CanvasSize;
  isValid?: (shape: CanvasShape) => boolean;

  // --- creation ---
  // Factory for tool-click / double-click creation. Upload/paste/drop-created
  // types (media, file, document, link) omit this and are created through their
  // own async flows instead.
  create?: (at: CanvasPoint, ctx: CanvasElementCreateContext) => CanvasShape;
  tool?: CanvasElementTool;

  // --- rendering ---
  surface: CanvasElementSurface;
  // Custom-element tag for DOM surfaces (e.g. "canvas-note"). The host renders
  // one of these per shape and feeds it `.shape` / `.context`.
  tag?: string;
  // Canvas-2d painter for canvas-surface types (sections). The host owns the
  // layer, ordering, hit-testing, and selection overlays.
  paint?: (
    ctx: CanvasRenderingContext2D,
    shape: CanvasShape,
    helpers: CanvasPaintHelpers,
  ) => void;

  // --- geometry / transforms ---
  transform: CanvasElementTransform;
  // "observe-dom" opts the element into the host's DOM auto-size driver (text,
  // link cards), which fits the shape to its measured content.
  autosize?: "observe-dom" | "none";

  // --- serialization quirks ---
  // Writes element-specific fields when persisting to Yjs. Defaults to the
  // host's generic field writer; text uses this to omit width/height.
  writeYMap?: (map: Y.Map<unknown>, shape: CanvasSerializedShape) => void;
  // Reads element-specific fields back from a Yjs map / serialized object.
  readYMap?: (read: CanvasShapeAttrReader, base: CanvasShape) => Partial<CanvasShape>;
  // Element-specific JSON serialization (text strips width/height).
  serialize?: (shape: CanvasShape) => CanvasSerializedShape;
}

// Deprecated alias kept so existing element modules keep compiling while the
// contract is populated. Prefer CanvasElementExtension in new code.
export type CanvasElementDefinition = CanvasElementExtension;
