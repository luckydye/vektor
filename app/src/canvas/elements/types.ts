import type {
  FreehandPoint,
  FreehandStroke,
  FreehandStrokeStyle,
} from "../../viewport/index.ts";

export type CanvasTool = "select" | "draw" | "note" | "text" | "section";
export type CanvasElementType = "note" | "text" | "image" | "video" | "document";
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
  updatedAt: number;
};

export type CanvasSnapshot = {
  version: 1;
  shapes: CanvasShape[];
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
