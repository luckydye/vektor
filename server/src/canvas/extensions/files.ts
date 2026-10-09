import {
  type MediaUploadOptions,
  mediaFilesFromDataTransfer,
  uploadMediaFile,
} from "#canvas/extensions/media.ts";
import { createModelShape } from "#canvas/extensions/model.ts";
import { shapePlacement, shapeQuad } from "#canvas/extensions/shapePaint.ts";
import { drawImage, drawRoundedRect } from "#canvas/render/primitives.ts";
import { svgImage } from "#canvas/render/svgImage.ts";
import { drawTextLayout, lineLayout } from "#canvas/render/text.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "#canvas/runtime/elementBase.ts";
import type {
  CanvasInputHandler,
  CanvasPaintHelpers,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import {
  FILE_COLORS,
  FILE_ICONS,
  getFileType,
} from "#editor/elements/file-attachment.ts";
import { isMediaFile, isModelFile } from "#files/fileTypes.ts";

const PDF_PREVIEW_SIZE = { width: 420, height: 560 };

function fileSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : "";
}

function fileName(shape: CanvasShape) {
  return typeof shape.data.alt === "string" ? shape.data.alt : "";
}

export const CanvasFile = CanvasElement.create({
  name: "file",

  addOptions() {
    return { size: { width: 220, height: 150 } };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.size,
      style: { color: "transparent" },
      data: { text: "" },
    };
  },

  isValid: (shape) => Boolean(fileSource(shape)),

  addRender() {
    return {
      // A PDF keeps its live viewer: WebGL has no PDF renderer.
      dom: (shape: CanvasShape) =>
        isPdfFile(fileName(shape)) || isPdfFile(fileSource(shape)),
      tag: "canvas-file",
      paint: paintFile,
      cursor: () => "move",
    };
  },

  // A click that did not drag opens the file.
  addEvents() {
    return {
      click: (shape: CanvasShape, host: { openUrl: (url: string) => void }) => {
        const src = fileSource(shape);
        if (src) host.openUrl(src);
      },
    };
  },

  addBehavior() {
    return { transform: { move: true, resize: "none" as const, rotate: false } };
  },

  // Relative upload paths are stored as-is and resolved against the origin the
  // document is being read from, so a canvas survives moving between hosts.
  parseData(data, context) {
    const src = data.src;
    return {
      ...data,
      src:
        typeof src === "string" && src.startsWith("/")
          ? `${context.currentOrigin}${src}`
          : src,
    };
  },

  addInput() {
    return {
      paste: {
        priority: 90,
        handle: (event, context) => handleFileInput(event, context, false),
      },
      drop: {
        priority: 100,
        handle: (event, context) => handleFileInput(event, context, true),
      },
    };
  },
});

function handleFileInput(
  event: ClipboardEvent | DragEvent,
  context: Parameters<CanvasInputHandler["handle"]>[1],
  acceptMetadataOnly: boolean,
) {
  if (!context.data || !dragHasCanvasFiles(context.data)) return false;
  const media = mediaFilesFromDataTransfer(context.data);
  const files = canvasFilesFromDataTransfer(context.data);
  if (media.length === 0 && files.length === 0 && !acceptMetadataOnly) return false;
  event.preventDefault();
  if (context.data) context.data.dropEffect = "copy";
  if (context.phase === "preview") return true;
  if (media.length > 0 || files.length > 0) {
    context.command("insert-files", { media, files, at: context.at() });
  }
  return true;
}

function isCanvasFile(file: File) {
  return !isMediaFile(file);
}

// Card geometry from `<file-attachment>`: an icon or text preview above a 1px
// divider and an info bar with a small icon and the filename.
const INFO_BAR = 34;
const textPreviews = new Map<string, string | "loading" | "error">();

function textPreview(src: string, invalidate: () => void): string | null {
  const cached = textPreviews.get(src);
  if (cached === "error") return "Unable to load preview";
  if (cached && cached !== "loading") return cached;
  if (!cached) {
    textPreviews.set(src, "loading");
    void fetch(src)
      .then((response) => {
        if (!response.ok) throw new Error(`File preview failed: ${response.status}`);
        return response.text();
      })
      .then(
        (text) =>
          textPreviews.set(src, text.slice(0, 500) + (text.length > 500 ? "\n..." : "")),
        () => textPreviews.set(src, "error"),
      )
      .then(invalidate);
  }
  return null;
}

function paintFile(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const { width, height } = shape.frame;
  const name =
    fileName(shape) || (typeof shape.data.text === "string" && shape.data.text) || "file";
  const type = getFileType(name);
  const color = FILE_COLORS[type];
  const dpr = helpers.dpr * helpers.scale;
  drawRoundedRect(gpu, shapeQuad(shape, helpers, 0, 0, width, height), {
    radius: 8 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-doc-bg")),
    stroke: parseColor(helpers.color("--canvas-doc-divider")),
    strokeWidth: helpers.scale,
  });
  // The preview area's tint is translucent in dark mode, so it sits on the card.
  drawRoundedRect(
    gpu,
    shapeQuad(shape, helpers, 1, 1, width - 2, height - INFO_BAR - 1),
    {
      radius: [7 * helpers.scale, 7 * helpers.scale, 0, 0],
      fill: parseColor(helpers.color("--canvas-tool-hover-bg")),
    },
  );
  const barTop = height - INFO_BAR;
  drawRoundedRect(gpu, shapeQuad(shape, helpers, 1, barTop, width - 2, 1), {
    fill: parseColor(helpers.color("--canvas-doc-divider")),
  });

  const src = fileSource(shape);
  if (type === "text" && src) {
    const preview = textPreview(src, helpers.invalidate) ?? "Loading preview...";
    const text = lineLayout(
      preview,
      {
        face: "mono",
        size: 11,
        color: helpers.color("--canvas-doc-content"),
      },
      helpers.invalidate,
      width - 32,
    );
    if (text) {
      drawTextLayout(
        gpu,
        text,
        shapePlacement(
          shape,
          helpers,
          { x: 16, y: 16 },
          {
            x: 0,
            y: 0,
            width: width - 32,
            height: Math.min(150, barTop - 32),
          },
        ),
      );
    }
  } else {
    const icon = svgImage(FILE_ICONS[type], color, 48 * dpr, helpers.invalidate);
    if (icon) {
      drawImage(
        gpu,
        icon,
        shapeQuad(shape, helpers, width / 2 - 24, barTop / 2 - 24, 48, 48),
      );
    }
  }

  const small = svgImage(FILE_ICONS[type], color, 16 * dpr, helpers.invalidate);
  if (small) {
    drawImage(
      gpu,
      small,
      shapeQuad(shape, helpers, 13, barTop + INFO_BAR / 2 - 8, 16, 16),
    );
  }
  const label = lineLayout(
    name,
    {
      face: "regular",
      size: 13,
      color: helpers.color("--canvas-doc-content"),
    },
    helpers.invalidate,
  );
  if (label) {
    drawTextLayout(
      gpu,
      label,
      shapePlacement(
        shape,
        helpers,
        { x: 37, y: barTop + (INFO_BAR - label.height) / 2 },
        {
          x: 0,
          y: 0,
          width: width - 37 - 12,
          height: label.height,
        },
      ),
    );
  }
}

// The live PDF viewer: an <iframe> under a filename header that drags.
class CanvasPdfElement extends CanvasElementBase {
  private frame: HTMLIFrameElement | null = null;
  private header: HTMLElement | null = null;

  protected mount() {
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
  }

  protected update() {
    const shape = this.shapeData;
    if (!shape || !this.frame || !this.header) return;
    const src = fileSource(shape);
    if (src && this.frame.getAttribute("src") !== src) this.frame.src = src;
    this.header.textContent = fileName(shape) || "PDF";
    this.header.title = fileName(shape) || "PDF";
  }
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-file")) {
  customElements.define("canvas-file", CanvasPdfElement);
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

function dragHasCanvasFiles(transfer: DataTransfer | null) {
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
      : CanvasFile.defaults.size;
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "file",
    frame: {
      x: Math.round(origin === "center" ? params.at.x - size.width / 2 : params.at.x),
      y: Math.round(origin === "center" ? params.at.y - size.height / 2 : params.at.y),
      width: size.width,
      height: size.height,
      rotation: 0,
    },
    style: { ...CanvasFile.defaults.style },
    data: { ...CanvasFile.defaults.data, src: params.src, alt: params.filename },
    updatedAt: Date.now(),
  };
}

export async function createUploadedFileShape(
  file: File,
  at: { x: number; y: number },
  options: MediaUploadOptions,
): Promise<CanvasShape | null> {
  if (!isCanvasFile(file)) return null;
  const src = await uploadMediaFile(file, options);
  const filename = file.name || "file";
  // 3D models render as a dedicated resizable model shape; every other file
  // keeps the generic attachment card.
  if (isModelFile(file)) return createModelShape({ at, src, filename });
  return createFileShape({ at, src, filename });
}
