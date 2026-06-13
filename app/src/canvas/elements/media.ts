import type { CanvasElementDefinition, CanvasShape } from "./types.ts";

const mediaMinSize = { width: 80, height: 60 };

export const imageElement: CanvasElementDefinition = {
  type: "image",
  defaultText: "",
  defaultColor: "transparent",
  defaultSize: { width: 240, height: 150 },
  minSize: mediaMinSize,
};

export const videoElement: CanvasElementDefinition = {
  type: "video",
  defaultText: "",
  defaultColor: "#000000",
  defaultSize: { width: 240, height: 150 },
  minSize: mediaMinSize,
};

export function isMediaElementType(type: string): type is "image" | "video" {
  return type === "image" || type === "video";
}

export function createMediaShape(params: {
  type: "image" | "video";
  at: { x: number; y: number };
  size: { width: number; height: number };
  src: string;
  alt?: string;
  origin?: "center" | "top-left";
}): CanvasShape {
  const definition = params.type === "video" ? videoElement : imageElement;
  const origin = params.origin ?? "center";
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: params.type,
    x: Math.round(
      origin === "center" ? params.at.x - params.size.width / 2 : params.at.x,
    ),
    y: Math.round(
      origin === "center" ? params.at.y - params.size.height / 2 : params.at.y,
    ),
    width: params.size.width,
    height: params.size.height,
    text: definition.defaultText,
    color: definition.defaultColor,
    src: params.src,
    alt: params.alt,
    updatedAt: Date.now(),
  };
}
