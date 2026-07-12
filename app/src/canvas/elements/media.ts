import { useUploads } from "#composeables/useUploads.ts";
import {
  isMediaFile,
  mediaTypeForFile,
  toAbsoluteUploadUrl,
} from "#utils/uploadFiles.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "./CanvasElementBase.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

const mediaMinSize = { width: 80, height: 60 };

export const imageElement: CanvasElementExtension = {
  type: "image",
  defaultText: "",
  defaultColor: "transparent",
  defaultSize: { width: 240, height: 150 },
  minSize: mediaMinSize,
  // Static images paint their pixels on the canvas layer but keep a DOM hit
  // target; GIFs render as a DOM <img> instead (see isGifSrc in the host).
  surface: "dom+canvas",
  tag: "canvas-image",
  transform: { move: true, resize: "box", rotate: true, aspectLocked: true },
};

export const videoElement: CanvasElementExtension = {
  type: "video",
  defaultText: "",
  defaultColor: "#000000",
  defaultSize: { width: 240, height: 150 },
  minSize: mediaMinSize,
  surface: "dom",
  tag: "canvas-video",
  transform: { move: true, resize: "box", rotate: true, aspectLocked: true },
};

// Audio renders as a fixed-height native player bar, so it has no natural
// pixel size and is not aspect-locked like image/video (see isMediaElementType).
const audioMinSize = { width: 220, height: 54 };
export const audioElement: CanvasElementExtension = {
  type: "audio",
  defaultText: "",
  defaultColor: "transparent",
  defaultSize: { width: 320, height: 54 },
  minSize: audioMinSize,
  surface: "dom",
  tag: "canvas-audio",
  transform: { move: true, resize: "none", rotate: false },
};

export function isMediaElementType(type: string): type is "image" | "video" {
  return type === "image" || type === "video";
}

// GIFs render as a live <img> in the DOM (static images are painted on the
// canvas layer instead, so they never reach this element).
class CanvasImageElement extends CanvasElementBase {
  private img: HTMLImageElement | null = null;

  protected mount() {
    const img = document.createElement("img");
    img.className = "canvas-shape-image";
    img.draggable = false;
    img.decoding = "async";
    dragOnPointerDown(img, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    this.appendChild(img);
    this.img = img;
  }

  protected update() {
    const shape = this.shapeData;
    if (!this.img || !shape) return;
    if (shape.src && this.img.getAttribute("src") !== shape.src) this.img.src = shape.src;
    this.img.alt = shape.alt || "";
  }

  protected teardown() {
    this.img = null;
  }
}

class CanvasVideoElement extends CanvasElementBase {
  private video: HTMLVideoElement | null = null;

  protected mount() {
    const video = document.createElement("video");
    video.className = "canvas-shape-image";
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.draggable = false;
    dragOnPointerDown(video, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    this.appendChild(video);
    this.video = video;
  }

  protected update() {
    const shape = this.shapeData;
    if (!this.video || !shape) return;
    if (shape.src && this.video.getAttribute("src") !== shape.src) {
      this.video.src = shape.src;
    }
    this.video.setAttribute("aria-label", shape.alt || "");
  }

  protected teardown() {
    this.video = null;
  }
}

// Native audio player. The grip handles selection/drag; the player keeps its
// own pointer events so its controls stay clickable.
class CanvasAudioElement extends CanvasElementBase {
  private audio: HTMLAudioElement | null = null;
  private handle: HTMLElement | null = null;

  protected mount() {
    const wrap = document.createElement("div");
    wrap.className = "canvas-shape-audio";
    // The wrapper only stops propagation; dragging happens from the grip.
    wrap.addEventListener("pointerdown", (event) => event.stopPropagation());

    const handle = document.createElement("div");
    handle.className = "canvas-shape-audio-handle";
    dragOnPointerDown(handle, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );

    const audio = document.createElement("audio");
    audio.className = "canvas-shape-audio-player";
    audio.controls = true;
    audio.preload = "metadata";

    wrap.append(handle, audio);
    this.appendChild(wrap);
    this.handle = handle;
    this.audio = audio;
  }

  protected update() {
    const shape = this.shapeData;
    if (!this.audio || !shape) return;
    const label = shape.alt || shape.text || "Audio";
    if (shape.src && this.audio.getAttribute("src") !== shape.src)
      this.audio.src = shape.src;
    this.audio.setAttribute("aria-label", label);
    this.handle?.setAttribute("title", label);
  }

  protected teardown() {
    this.audio = null;
    this.handle = null;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("canvas-image")) {
    customElements.define("canvas-image", CanvasImageElement);
  }
  if (!customElements.get("canvas-video")) {
    customElements.define("canvas-video", CanvasVideoElement);
  }
  if (!customElements.get("canvas-audio")) {
    customElements.define("canvas-audio", CanvasAudioElement);
  }
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
          item.type.startsWith("video/") ||
          item.type.startsWith("audio/")),
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
  // Audio has no intrinsic pixel size; use the player-bar default size.
  let size = audioElement.defaultSize;
  if (type !== "audio") {
    const natural = await (type === "video" ? videoSize(src) : imageSize(src));
    size = fitMediaSize(natural.width, natural.height);
  }
  return createMediaShape({
    type,
    at,
    size,
    src,
    alt: file.name,
  });
}

export function createMediaShape(params: {
  type: "image" | "video" | "audio";
  at: { x: number; y: number };
  size: { width: number; height: number };
  src: string;
  alt?: string;
  origin?: "center" | "top-left";
}): CanvasShape {
  const definition =
    params.type === "video"
      ? videoElement
      : params.type === "audio"
        ? audioElement
        : imageElement;
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
    rotation: 0,
    text: definition.defaultText,
    color: definition.defaultColor,
    src: params.src,
    alt: params.alt,
    updatedAt: Date.now(),
  };
}
