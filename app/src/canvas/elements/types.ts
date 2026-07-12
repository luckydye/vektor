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

export type CanvasElementDefinition = {
  type: CanvasElementType;
  defaultText: string;
  defaultColor: string;
  defaultSize: CanvasSize;
  minSize: CanvasSize;
  isValid?: (shape: CanvasShape) => boolean;
};
