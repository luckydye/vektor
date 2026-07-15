import { pointInRotatedShape } from "#canvas/geometry.ts";
import { useUploads } from "#composeables/useUploads.ts";
import {
  IMAGE_RESIZE_TIERS,
  resizeImageUrl,
  transformImageUrl,
} from "#utils/imageUrlTransformers.ts";
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
import type {
  CanvasElementExtension,
  CanvasRasterPaintHelpers,
  CanvasShape,
} from "./types.ts";

const mediaMinSize = { width: 80, height: 60 };

function parseMediaData(
  data: Record<string, unknown>,
  context: { currentOrigin: string },
) {
  const src = data.src;
  return {
    ...data,
    src:
      typeof src === "string" && src.startsWith("/")
        ? `${context.currentOrigin}${src}`
        : src,
  };
}

const imageCache = new Map<string, HTMLImageElement | "loading" | "error">();

function mediaSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : "";
}

function mediaAlt(shape: CanvasShape) {
  return typeof shape.data.alt === "string" ? shape.data.alt : "";
}

function cachedImageFallback(src: string): HTMLImageElement | null {
  for (let index = IMAGE_RESIZE_TIERS.length - 1; index >= 0; index--) {
    const cached = imageCache.get(resizeImageUrl(src, IMAGE_RESIZE_TIERS[index]));
    if (cached instanceof HTMLImageElement) return cached;
  }
  const cached = imageCache.get(src);
  return cached instanceof HTMLImageElement ? cached : null;
}

function paintStaticImage(
  context: CanvasRenderingContext2D,
  shape: CanvasShape,
  helpers: CanvasRasterPaintHelpers,
) {
  const src = mediaSource(shape);
  if (!src) return;
  const frame = shape.frame;
  const width = frame.width * helpers.scale;
  const height = frame.height * helpers.scale;
  if (width <= 0 || height <= 0) return;

  const targetPixels = Math.ceil(width * helpers.dpr);
  const tieredSrc = resizeImageUrl(src, targetPixels);
  const cached = imageCache.get(tieredSrc);
  if (!cached) {
    imageCache.set(tieredSrc, "loading");
    const image = new Image();
    image.src = tieredSrc;
    image
      .decode()
      .then(() => {
        imageCache.set(tieredSrc, image);
        helpers.invalidate();
      })
      .catch(() => {
        imageCache.set(tieredSrc, "error");
        helpers.invalidate();
      });
  }

  const displayImage =
    cached instanceof HTMLImageElement ? cached : cachedImageFallback(src);
  const centerX = (frame.x + frame.width / 2) * helpers.scale + helpers.dx;
  const centerY = (frame.y + frame.height / 2) * helpers.scale + helpers.dy;
  const angle = (frame.rotation * Math.PI) / 180;

  context.save();
  context.translate(centerX, centerY);
  context.rotate(angle);
  if (displayImage) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(displayImage, -width / 2, -height / 2, width, height);
  } else {
    context.fillStyle = "rgba(128,128,128,0.15)";
    context.fillRect(-width / 2, -height / 2, width, height);
  }

  context.restore();
}

// GIFs must animate, so they render as a live DOM <img>; every other image is a
// still frame the host rasterizes on the canvas layer. Owned here (not the
// host) since it is image-type knowledge.
export function isGifSrc(src: string): boolean {
  return /\.gif($|\?)/i.test(src);
}

export const imageElement: CanvasElementExtension = {
  type: "image",
  defaults: {
    size: { width: 240, height: 150 },
    minSize: mediaMinSize,
    style: { color: "transparent" },
    data: { text: "" },
  },
  render: {
    surface: "dom+canvas",
    rasterize: (shape) => !isGifSrc(mediaSource(shape)),
    tag: "canvas-image",
    article: { background: false },
    paintRaster: paintStaticImage,
    hitTest: (shape, world) => (pointInRotatedShape(world, shape.frame) ? "body" : null),
  },
  behavior: {
    transform: { move: true, resize: "box", rotate: true, aspectLocked: true },
  },
  storage: { parseData: parseMediaData },
  input: {
    paste: {
      priority: 60,
      handle: (event, context) => {
        const originalUrl = context.data?.getData("text/plain").trim() ?? "";
        const fetchUrl = transformImageUrl(originalUrl);
        if (!fetchUrl) return false;
        event.preventDefault();
        context.command("insert-image-url", {
          fetchUrl,
          originalUrl,
          at: context.at(),
        });
        return true;
      },
    },
  },
};

export const videoElement: CanvasElementExtension = {
  type: "video",
  defaults: {
    size: { width: 240, height: 150 },
    minSize: mediaMinSize,
    style: { color: "#000000" },
    data: { text: "" },
  },
  render: { surface: "dom", tag: "canvas-video" },
  behavior: {
    transform: { move: true, resize: "box", rotate: true, aspectLocked: true },
  },
  storage: { parseData: parseMediaData },
};

// Audio renders as a fixed-height native player bar, so it has no natural pixel
// size and (unlike image/video) is not aspect-locked.
const audioMinSize = { width: 220, height: 54 };
export const audioElement: CanvasElementExtension = {
  type: "audio",
  defaults: {
    size: { width: 320, height: 54 },
    minSize: audioMinSize,
    style: { color: "transparent" },
    data: { text: "" },
  },
  render: { surface: "dom", tag: "canvas-audio" },
  behavior: { transform: { move: true, resize: "none", rotate: false } },
  storage: { parseData: parseMediaData },
};

// A single media tag (img/video) that drags from its own body and tracks
// shape.data.src/alt. GIF images render here as a live <img> (static images are
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
    const src = mediaSource(shape);
    if (src && this.media.getAttribute("src") !== src) {
      this.media.setAttribute("src", src);
    }
    this.applyLabel(this.media, mediaAlt(shape));
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
    const text = typeof shape.data.text === "string" ? shape.data.text : "";
    const label = mediaAlt(shape) || text || "Audio";
    const src = mediaSource(shape);
    if (src && this.audio.getAttribute("src") !== src) this.audio.src = src;
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

export async function imageFileFromUrl(fetchUrl: string, originalUrl: string) {
  const response = await fetch(fetchUrl);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new Error("URL did not return an image");
  const blob = await response.blob();
  const name = new URL(originalUrl).pathname.split("/").pop() || "image";
  return new File([blob], name, { type: blob.type });
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
  let size = audioElement.defaults.size;
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
    frame: {
      x: Math.round(
        origin === "center" ? params.at.x - params.size.width / 2 : params.at.x,
      ),
      y: Math.round(
        origin === "center" ? params.at.y - params.size.height / 2 : params.at.y,
      ),
      width: params.size.width,
      height: params.size.height,
      rotation: 0,
    },
    style: { ...definition.defaults.style },
    data: { ...definition.defaults.data, src: params.src, alt: params.alt },
    updatedAt: Date.now(),
  };
}
