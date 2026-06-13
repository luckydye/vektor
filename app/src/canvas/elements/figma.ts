import { figmaClipboardToFrames } from "../../utils/figma-clipboard.ts";
import { createMediaShape } from "./media.ts";
import type { CanvasShape } from "./types.ts";

export type PasteFigmaClipboardOptions = {
  uploadMediaFile: (file: File) => Promise<string>;
  insertShape: (shape: CanvasShape) => void;
};

export type PasteFigmaClipboardResult = {
  pasted: boolean;
  createdIds: string[];
  error?: unknown;
};

export function isFigmaClipboardHtml(html: string): boolean {
  return html.includes("(figmeta)") && html.includes("(figma)");
}

// Pastes a Figma selection: each top-level node becomes its own image shape,
// laid out to preserve the relative positions and sizes they had in Figma.
// Returns false when nothing is renderable so the caller can fall back to the
// OS clipboard's bitmap flavor.
export async function pasteFigmaClipboard(
  html: string,
  at: { x: number; y: number },
  options: PasteFigmaClipboardOptions,
): Promise<PasteFigmaClipboardResult> {
  const frames = await figmaClipboardToFrames(html);
  if (!frames || frames.length === 0) {
    return { pasted: false, createdIds: [] };
  }

  // Shared scale keeps the frames' relative sizes; clamp the largest so a
  // screen-sized frame does not paste enormous.
  const maxW = Math.max(...frames.map((f) => f.width));
  const maxH = Math.max(...frames.map((f) => f.height));
  const scale = Math.min(1, 480 / Math.max(1, maxW), 360 / Math.max(1, maxH));

  // World-space bounding box of the whole selection.
  const minX = Math.min(...frames.map((f) => f.x));
  const minY = Math.min(...frames.map((f) => f.y));
  const maxX = Math.max(...frames.map((f) => f.x + f.width));
  const maxY = Math.max(...frames.map((f) => f.y + f.height));
  const groupLeft = at.x - ((maxX - minX) * scale) / 2;
  const groupTop = at.y - ((maxY - minY) * scale) / 2;

  const createdIds: string[] = [];
  try {
    for (const frame of frames) {
      const file = new File([frame.svg], `${frame.name || "figma"}.svg`, {
        type: "image/svg+xml",
      });
      const src = await options.uploadMediaFile(file);
      const shape = createMediaShape({
        type: "image",
        at: {
          x: groupLeft + (frame.x - minX) * scale,
          y: groupTop + (frame.y - minY) * scale,
        },
        size: {
          width: Math.max(1, Math.round(frame.width * scale)),
          height: Math.max(1, Math.round(frame.height * scale)),
        },
        src,
        alt: frame.name,
        origin: "top-left",
      });
      options.insertShape(shape);
      createdIds.push(shape.id);
    }
    return { pasted: true, createdIds };
  } catch (error) {
    return { pasted: createdIds.length > 0, createdIds, error };
  }
}
