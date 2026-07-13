import { pointInRotatedShape } from "#canvas/geometry.ts";
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

// GIFs must animate, so they render as a live DOM <img>; every other image is a
// still frame the host rasterizes on the canvas layer. Owned here (not the
// host) since it is image-type knowledge.
export function isGifSrc(src: string): boolean {
  return /\.gif($|\?)/i.test(src);
}

export const imageElement: CanvasElementExtension = {
  type: "image",
  defaultText: "",
  defaultColor: "transparent",
  defaultSize: { width: 240, height: 150 },
  minSize: mediaMinSize,
  // Still images paint their pixels on the canvas layer but keep a DOM hit
  // target; GIFs render as a live DOM <img> instead.
  surface: "dom+canvas",
  rendersOnCanvas: (shape) => !isGifSrc(shape.src ?? ""),
  tag: "canvas-image",
  // A GIF fills its article; the card color would only show at the edges.
  articleBackground: false,
  transform: { move: true, resize: "box", rotate: true, aspectLocked: true },
  // Canvas-painted (non-GIF) images hit-test against their rotated box.
  hitTest: (shape, world) => (pointInRotatedShape(world, shape) ? "body" : null),
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

// Audio renders as a fixed-height native player bar, so it has no natural pixel
// size and (unlike image/video) is not aspect-locked.
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

// A single media tag (img/video) that drags from its own body and tracks
// shape.src/alt. GIF images render here as a live <img> (static images are
// painted on the canvas layer instead, so they never reach this element).
abstract class CanvasMediaTagElement extends CanvasElementBase {
  private media: HTMLElement | null = null;
  protected abstract createMedia(): HTMLElement;
  protected abstract applyLabel(el: HTMLElement, alt: string): void;

  protected mount() {
    const media = this.createMedia();
    media.className = "canvas-shape-image";
    (media as HTMLImageElement).draggable = false;
    dragOnPointerDown(media, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    this.appendChild(media);
    this.media = media;
  }

  protected update() {
    const shape = this.shapeData;
    if (!this.media || !shape) return;
    if (shape.src && this.media.getAttribute("src") !== shape.src) {
      this.media.setAttribute("src", shape.src);
    }
    this.applyLabel(this.media, shape.alt || "");
  }
}

class CanvasImageElement extends CanvasMediaTagElement {
  protected createMedia() {
    const img = document.createElement("img");
    img.decoding = "async";
    return img;
  }
  protected applyLabel(el: HTMLElement, alt: string) {
    (el as HTMLImageElement).alt = alt;
  }
}

class CanvasVideoElement extends CanvasMediaTagElement {
  protected createMedia() {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    return video;
  }
  protected applyLabel(el: HTMLElement, alt: string) {
    el.setAttribute("aria-label", alt);
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
