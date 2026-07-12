import "#editor/elements/file-attachment.ts";
import { isMediaFile } from "#utils/uploadFiles.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "./CanvasElementBase.ts";
import { uploadMediaFile } from "./media.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

const PDF_PREVIEW_SIZE = { width: 420, height: 560 };

export const fileElement: CanvasElementExtension = {
  type: "file",
  defaultText: "",
  defaultColor: "transparent",
  defaultSize: { width: 220, height: 150 },
  minSize: { width: 220, height: 150 },
  isValid: (shape) => Boolean(shape.src),
  surface: "dom",
  tag: "canvas-file",
  transform: { move: true, resize: "none", rotate: false },
};

export function isCanvasFile(file: File) {
  return !isMediaFile(file);
}

// File body: PDFs get an inline <iframe> viewer with a drag header; everything
// else renders the shared <file-attachment> card. PDF-ness is fixed for a given
// file shape (its src/filename never change), so it's decided once at mount.
class CanvasFileElement extends CanvasElementBase {
  private isPdf = false;
  private frame: HTMLIFrameElement | null = null;
  private header: HTMLElement | null = null;
  private attachment: HTMLElement | null = null;

  protected mount() {
    const shape = this.shapeData;
    this.isPdf = isPdfFile(shape?.alt) || isPdfFile(shape?.src);

    if (this.isPdf) {
      const wrap = document.createElement("div");
      wrap.className = "canvas-pdf-preview";
      // The viewer keeps scroll/text-selection/toolbar events; only the header
      // starts a drag.
      wrap.addEventListener("pointerdown", (event) => event.stopPropagation());

      const header = document.createElement("div");
      header.className = "canvas-pdf-preview-header";
      dragOnPointerDown(header, (event) =>
        this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
      );

      const frame = document.createElement("iframe");
      frame.className = "canvas-pdf-preview-frame";
      frame.title = "PDF preview";

      wrap.append(header, frame);
      this.appendChild(wrap);
      this.header = header;
      this.frame = frame;
      return;
    }

    const attachment = document.createElement("file-attachment");
    attachment.className = "canvas-shape-file";
    dragOnPointerDown(attachment, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    // Capture-phase guard: a click that ended a drag must not navigate.
    attachment.addEventListener(
      "click",
      (event) => {
        if (this.context?.wasDragged()) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
    this.appendChild(attachment);
    this.attachment = attachment;
  }

  protected update() {
    const shape = this.shapeData;
    if (!shape) return;
    const filename = shape.alt || shape.text || (this.isPdf ? "PDF" : "file");
    if (this.isPdf) {
      if (this.frame && shape.src && this.frame.getAttribute("src") !== shape.src) {
        this.frame.src = shape.src;
      }
      if (this.header) {
        this.header.textContent = filename;
        this.header.title = shape.alt || "PDF";
      }
      return;
    }
    if (this.attachment && shape.src) {
      this.attachment.setAttribute("src", shape.src);
      this.attachment.setAttribute("filename", filename);
    }
  }

  protected teardown() {
    this.frame = null;
    this.header = null;
    this.attachment = null;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-file")) {
  customElements.define("canvas-file", CanvasFileElement);
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
    rotation: 0,
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
