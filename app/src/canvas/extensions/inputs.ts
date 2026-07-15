import { ref } from "vue";
import { canvasClipboardFromDataTransfer } from "#utils/clipboard.ts";
import { canvasFilesFromList } from "./files.ts";
import { mediaFilesFromList } from "./media.ts";
import type { CanvasInputHandler, CanvasPoint, CanvasShape } from "./types.ts";

type UploadShapeType = "image" | "video" | "audio" | "file";

// Engine clipboard payloads are the only built-in input format rather than an
// element contribution. Element-specific recognizers live with their extension.
export const canvasClipboardInput: CanvasInputHandler = {
  priority: 1000,
  handle: (event, context) => {
    const payload = canvasClipboardFromDataTransfer(context.data);
    if (!payload) return false;
    event.preventDefault();
    context.command("paste-canvas", { payload, at: context.at() });
    return true;
  },
};

export function createUploadPlaceholderStore(options: {
  sizeFor: (type: UploadShapeType) => { width: number; height: number };
}) {
  const items = ref<
    Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      filename: string;
    }>
  >([]);
  return {
    items,
    add(type: UploadShapeType, filename: string, at: CanvasPoint) {
      const size = options.sizeFor(type);
      const id = `upload-${crypto.randomUUID()}`;
      items.value = [
        ...items.value,
        {
          id,
          x: Math.round(at.x - size.width / 2),
          y: Math.round(at.y - size.height / 2),
          width: size.width,
          height: size.height,
          filename,
        },
      ];
      return id;
    },
    remove(id: string) {
      items.value = items.value.filter((item) => item.id !== id);
    },
  };
}

export function splitCanvasFiles(files: FileList | File[]) {
  return { media: mediaFilesFromList(files), files: canvasFilesFromList(files) };
}

export function createCanvasFileInsertionQueue(options: {
  createMedia: (file: File, at: CanvasPoint) => Promise<CanvasShape | null>;
  createFile: (file: File, at: CanvasPoint) => Promise<CanvasShape | null>;
  mediaType: (file: File) => Exclude<UploadShapeType, "file"> | null;
  addPlaceholder: (type: UploadShapeType, filename: string, at: CanvasPoint) => string;
  removePlaceholder: (id: string) => void;
  insert: (shape: CanvasShape) => void;
  select: (shapeId: string) => void;
  setBusy: (busy: boolean) => void;
  reportError: (error: unknown) => void;
}) {
  async function add(file: File, at: CanvasPoint, kind: "media" | "file") {
    options.setBusy(true);
    const type = kind === "media" ? (options.mediaType(file) ?? "image") : "file";
    const placeholder = options.addPlaceholder(type, file.name || "file", at);
    try {
      const shape = await (kind === "media"
        ? options.createMedia(file, at)
        : options.createFile(file, at));
      options.removePlaceholder(placeholder);
      if (!shape) return;
      options.insert(shape);
      options.select(shape.id);
    } catch (error) {
      options.removePlaceholder(placeholder);
      options.reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  return {
    addMedia: (file: File, at: CanvasPoint) => add(file, at, "media"),
    addFile: (file: File, at: CanvasPoint) => add(file, at, "file"),
    async addDropped(media: File[], files: File[], at: CanvasPoint) {
      let offset = 0;
      for (const file of media) {
        await add(file, { x: at.x + offset, y: at.y + offset }, "media");
        offset += 24;
      }
      for (const file of files) {
        await add(file, { x: at.x + offset, y: at.y + offset }, "file");
        offset += 24;
      }
    },
  };
}
