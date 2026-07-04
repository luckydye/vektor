import type {
  FreehandPoint,
  FreehandStroke,
  FreehandStrokeStyle,
} from "../../viewport/index.ts";

export type CanvasTool = "select" | "draw" | "note" | "text" | "section" | "shape";
export type CanvasElementType =
  | "note"
  | "text"
  | "shape"
  | "image"
  | "video"
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
  text: string;
  color: string;
  src?: string;
  alt?: string;
  docId?: string;
  // Which entry of the shape library a "shape" element was placed from
  // (e.g. "rectangle", "circle"); unset for every other element type.
  variant?: string;
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
  updatedAt: number;
};

export type CanvasStroke = FreehandStroke & {
  id: string;
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
