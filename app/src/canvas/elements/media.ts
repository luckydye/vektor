import { useUploads } from "#composeables/useUploads.ts";
import {
  isImageFile,
  isMediaFile,
  isVideoFile,
  mediaTypeForFile,
  toAbsoluteUploadUrl,
} from "#utils/uploadFiles.ts";
import type { CanvasElementDefinition, CanvasShape } from "./types.ts";

// Re-exported so existing canvas imports keep working; the canonical
// implementations now live in #utils/uploadFiles.ts.
export { isImageFile, isMediaFile, isVideoFile, mediaTypeForFile };

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

export function mediaFilesFromList(files: FileList | File[]) {
  return Array.from(files).filter(isMediaFile);
}

// Images on the clipboard (e.g. a screenshot or "copy image") may arrive in
// `files`, in `items` as a file entry, or both. Prefer `files` when present so
// the same pasted image is not inserted twice.
export function mediaFilesFromDataTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length === 0) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  const seen = new Set<string>();
  return mediaFilesFromList(
    files.filter((file) => {
      const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

// During dragover the browser hides file contents (dataTransfer.files is
// empty); only item kind/type metadata is available to decide acceptance.
export function dragHasMediaFiles(transfer: DataTransfer | null) {
  if (!transfer) return false;
  if (transfer.items.length > 0) {
    return Array.from(transfer.items).some(
      (item) =>
        item.kind === "file" &&
        (item.type === "" ||
          item.type.startsWith("image/") ||
          item.type.startsWith("video/")),
    );
  }
  return transfer.types.includes("Files");
}

export async function uploadMediaFile(
  file: File,
  options: { spaceId: string; documentId?: string },
): Promise<string> {
  const result = await useUploads().uploadFile(file, {
    spaceId: options.spaceId,
    documentId: options.documentId,
  });
  return toAbsoluteUploadUrl(result.url);
}

export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || 320,
        height: image.naturalHeight || 220,
      });
    image.onerror = () => resolve({ width: 320, height: 220 });
    image.src = src;
  });
}

export function videoSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      resolve({
        width: video.videoWidth || 320,
        height: video.videoHeight || 220,
      });
    video.onerror = () => resolve({ width: 320, height: 220 });
    video.src = src;
  });
}

export function fitMediaSize(width: number, height: number) {
  const maxWidth = 480;
  const maxHeight = 360;
  const scale = Math.min(
    1,
    maxWidth / Math.max(1, width),
    maxHeight / Math.max(1, height),
  );
  return {
    width: Math.max(mediaMinSize.width, Math.round(width * scale)),
    height: Math.max(mediaMinSize.height, Math.round(height * scale)),
  };
}

export async function createUploadedMediaShape(
  file: File,
  at: { x: number; y: number },
  options: { spaceId: string; documentId?: string },
): Promise<CanvasShape | null> {
  const type = mediaTypeForFile(file);
  if (!type) return null;

  const src = await uploadMediaFile(file, options);
  const naturalSize = await (type === "video" ? videoSize(src) : imageSize(src));
  return createMediaShape({
    type,
    at,
    size: fitMediaSize(naturalSize.width, naturalSize.height),
    src,
    alt: file.name,
  });
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
