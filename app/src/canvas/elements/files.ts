import "#editor/elements/file-attachment.ts";
import { isMediaFile } from "#utils/uploadFiles.ts";
import { uploadMediaFile } from "./media.ts";
import type { CanvasElementDefinition, CanvasShape } from "./types.ts";

const PDF_PREVIEW_SIZE = { width: 420, height: 560 };

export const fileElement: CanvasElementDefinition = {
  type: "file",
  defaultText: "",
  defaultColor: "transparent",
  defaultSize: { width: 220, height: 150 },
  minSize: { width: 220, height: 150 },
  isValid: (shape) => Boolean(shape.src),
};

export function isCanvasFile(file: File) {
  return !isMediaFile(file);
}

/** Whether a filename or upload URL points at a PDF. */
export function isPdfFile(value: string | undefined): boolean {
  return /\.pdf(?:$|[?#])/i.test(value ?? "");
}

export function canvasFilesFromList(files: FileList | File[]) {
  return Array.from(files).filter(isCanvasFile);
}

export function canvasFilesFromDataTransfer(
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
  return canvasFilesFromList(
    files.filter((file) => {
      const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

export function dragHasCanvasFiles(transfer: DataTransfer | null) {
  if (!transfer) return false;
  if (transfer.items.length > 0) {
    return Array.from(transfer.items).some((item) => item.kind === "file");
  }
  return transfer.types.includes("Files");
}

export function createFileShape(params: {
  at: { x: number; y: number };
  src: string;
  filename: string;
  origin?: "center" | "top-left";
}): CanvasShape {
  const origin = params.origin ?? "center";
  const size =
    isPdfFile(params.filename) || isPdfFile(params.src)
      ? PDF_PREVIEW_SIZE
      : fileElement.defaultSize;
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "file",
    x: Math.round(origin === "center" ? params.at.x - size.width / 2 : params.at.x),
    y: Math.round(origin === "center" ? params.at.y - size.height / 2 : params.at.y),
    width: size.width,
    height: size.height,
    text: fileElement.defaultText,
    color: fileElement.defaultColor,
    src: params.src,
    alt: params.filename,
    updatedAt: Date.now(),
  };
}

export async function createUploadedFileShape(
  file: File,
  at: { x: number; y: number },
  options: { spaceId: string; documentId?: string },
): Promise<CanvasShape | null> {
  if (!isCanvasFile(file)) return null;
  const src = await uploadMediaFile(file, options);
  return createFileShape({
    at,
    src,
    filename: file.name || "file",
  });
}
