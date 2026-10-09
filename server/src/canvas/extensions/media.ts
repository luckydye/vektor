import { shapePlacement, shapeQuad } from "#canvas/extensions/shapePaint.ts";
import { animatesImages, drawAnimatedImage } from "#canvas/render/animatedImage.ts";
import { sameOriginMediaUrl } from "#canvas/render/imageSource.ts";
import { drawImage, drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import { svgImage } from "#canvas/render/svgImage.ts";
import { drawTextLayout, lineLayout } from "#canvas/render/text.ts";
import { drawVideo } from "#canvas/render/video.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import type { CanvasPaintHelpers, CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import type { CanvasPoint } from "#canvas/runtime/geometry.ts";
import { localPointInShape, pointInRotatedShape } from "#canvas/runtime/geometry.ts";
import { isMediaFile, mediaTypeForFile, toAbsoluteUploadUrl } from "#files/fileTypes.ts";
import { withTransformParams } from "#files/transformUrl.ts";

const mediaMinSize = { width: 80, height: 60 };

// Attempt to transform a pasted URL into a direct image fetch URL.
// Returns null if no transformer matches.
function transformImageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (url.hostname === "unsplash.com" && /^\/photos\/[\w-]+/.test(url.pathname)) {
    const id = url.pathname.split("/")[2];
    return `https://unsplash.com/photos/${id}/download?force=true`;
  }
  if (url.hostname === "images.unsplash.com") return url.href;
  if (
    (url.hostname === "imgur.com" || url.hostname === "www.imgur.com") &&
    /^\/(?!a\/|gallery\/)[\w]+$/.test(url.pathname)
  ) {
    return `https://i.imgur.com/${url.pathname.slice(1)}.jpg`;
  }
  if (url.hostname === "i.imgur.com") return url.href;
  if (
    (url.hostname === "www.pexels.com" || url.hostname === "pexels.com") &&
    url.pathname.startsWith("/photo/")
  ) {
    const match = url.pathname.match(/(\d+)\/?$/);
    if (!match) return url.href;
    return `https://images.pexels.com/photos/${match[1]}/pexels-photo-${match[1]}.jpeg?auto=compress&cs=tinysrgb&w=1260`;
  }
  if (url.hostname === "i.redd.it") return url.href;
  if (url.hostname === "preview.redd.it") {
    const slug = url.pathname.split("/").filter(Boolean)[0] || "";
    const idWithExt = slug.split("-").pop() || slug;
    return `https://i.redd.it/${idWithExt}`;
  }
  if (url.hostname === "upload.wikimedia.org" || url.hostname === "commons.wikimedia.org")
    return url.href;
  if (url.hostname === "pbs.twimg.com") return url.href;
  if (url.hostname.endsWith("staticflickr.com")) return url.href;
  if (url.hostname.endsWith("cdninstagram.com")) return url.href;
  // Direct image URL by extension — catch-all, must be last
  if (/\.(jpe?g|png|webp|tiff?|avif|heic|bmp|gif)(\?.*)?$/i.test(url.pathname))
    return url.href;

  return null;
}

// Must be a subset of ALLOWED_DIMENSIONS in files/transforms.ts.
const IMAGE_RESIZE_TIERS = [320, 1280] as const;

// Returns a URL for the smallest server-side resize tier that covers targetPx.
// Only affects local upload URLs (/api/v1/spaces/…); everything else is
// returned unchanged because only local uploads go through the resize pipeline.
function resizeImageUrl(url: string, targetPx: number): string {
  let tier = 0;
  for (const t of IMAGE_RESIZE_TIERS) {
    if (targetPx <= t) {
      tier = t;
      break;
    }
  }
  // targetPx exceeds the largest preset — serve the full-resolution original.
  if (tier === 0) return url;
  return withTransformParams(url, { w: tier });
}

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

function isGifSrc(src: string): boolean {
  return /\.gif($|\?)/i.test(src);
}

function paintImage(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const src = mediaSource(shape);
  if (!src || shape.frame.width <= 0 || shape.frame.height <= 0) return;
  const quad = shapeQuad(shape, helpers, 0, 0, shape.frame.width, shape.frame.height);
  // Without ImageDecoder (Safari) a GIF takes the static path and shows its first frame.
  if (animatesImages && isGifSrc(src)) {
    if (!drawAnimatedImage(gpu, src, quad, helpers.requestFrame)) {
      drawRoundedRect(gpu, quad, { fill: [0.5, 0.5, 0.5, 0.15] });
    }
    return;
  }

  const targetPixels = Math.ceil(shape.frame.width * helpers.scale * helpers.dpr);
  const tieredSrc = resizeImageUrl(src, targetPixels);
  const cached = imageCache.get(tieredSrc);
  if (!cached) {
    imageCache.set(tieredSrc, "loading");
    const image = new Image();
    image.src = sameOriginMediaUrl(tieredSrc);
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
  if (displayImage) drawImage(gpu, displayImage, quad);
  else drawRoundedRect(gpu, quad, { fill: [0.5, 0.5, 0.5, 0.15] });
}

function paintVideo(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const src = mediaSource(shape);
  if (!src || shape.frame.width <= 0 || shape.frame.height <= 0) return;
  const quad = shapeQuad(shape, helpers, 0, 0, shape.frame.width, shape.frame.height);
  drawRoundedRect(gpu, quad, { fill: parseColor(helpers.color("--canvas-image-bg")) });
  drawVideo(gpu, src, quad, helpers.requestFrame);
}

function hitBody(shape: CanvasShape, world: { x: number; y: number }) {
  return pointInRotatedShape(world, shape.frame) ? "body" : null;
}

export const CanvasImage = CanvasElement.create({
  name: "image",

  addOptions() {
    return { size: { width: 240, height: 150 }, minSize: mediaMinSize };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "transparent" },
      data: { text: "" },
    };
  },

  addRender() {
    return { paint: paintImage, hitTest: hitBody };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: true, aspectLocked: true },
    };
  },

  parseData: parseMediaData,

  addInput() {
    return {
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
    };
  },
});

export const CanvasVideo = CanvasElement.create({
  name: "video",

  addOptions() {
    return { size: { width: 240, height: 150 }, minSize: mediaMinSize };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "#000000" },
      data: { text: "" },
    };
  },

  addRender() {
    return { paint: paintVideo, hitTest: hitBody };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: true, aspectLocked: true },
    };
  },

  parseData: parseMediaData,
});

// Audio renders as a fixed-height native player bar, so it has no natural pixel
// size and (unlike image/video) is not aspect-locked.
export const CanvasAudio = CanvasElement.create({
  name: "audio",

  addOptions() {
    return { size: { width: 320, height: 54 }, minSize: { width: 220, height: 54 } };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "transparent" },
      data: { text: "" },
    };
  },

  addRender() {
    return {
      paint: paintAudio,
      hitTest: (shape: CanvasShape, world: { x: number; y: number }) => {
        const local = localPointInShape(shape.frame, world);
        if (local.x < 0 || local.y < 0) return null;
        if (local.x > shape.frame.width || local.y > shape.frame.height) return null;
        if (local.x < AUDIO_GRIP) return "grip";
        return local.x < AUDIO_BAR_LEFT ? "play" : "seek";
      },
      cursor: (_shape: CanvasShape, region: string) =>
        region === "grip" ? "move" : "pointer",
    };
  },

  addBehavior() {
    return { transform: { move: true, resize: "none" as const, rotate: false } };
  },

  // A click on the button plays or pauses; on the bar it seeks.
  addEvents() {
    return {
      click: (
        shape: CanvasShape,
        _host: unknown,
        hit: { region: string; local: CanvasPoint },
      ) => {
        const audio = audioFor(mediaSource(shape));
        if (hit.region === "play") {
          if (audio.paused) void audio.play();
          else audio.pause();
        }
        if (hit.region === "seek" && Number.isFinite(audio.duration)) {
          const track = shape.frame.width - AUDIO_BAR_LEFT - 12;
          const at = Math.min(1, Math.max(0, (hit.local.x - AUDIO_BAR_LEFT) / track));
          audio.currentTime = at * audio.duration;
        }
      },
    };
  },

  parseData: parseMediaData,
});

// Player geometry: a dotted grip, a play button, the time, then the track.
const AUDIO_GRIP = 16;
const AUDIO_BAR_LEFT = 130;
const PLAY_ICON =
  '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>';
const PAUSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

const audioElements = new Map<string, HTMLAudioElement>();
// The latest painter's repaint, called when the player's state changes.
const audioRepaints = new WeakMap<HTMLAudioElement, () => void>();

// One detached player per source; WebGL draws its controls.
function audioFor(src: string): HTMLAudioElement {
  let audio = audioElements.get(src);
  if (!audio) {
    const created = new Audio(sameOriginMediaUrl(src));
    created.preload = "metadata";
    for (const event of ["loadedmetadata", "play", "pause", "ended", "seeked"]) {
      created.addEventListener(event, () => audioRepaints.get(created)?.());
    }
    audioElements.set(src, created);
    audio = created;
  }
  return audio;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function paintAudio(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const src = mediaSource(shape);
  const audio = audioFor(src);
  const { width, height } = shape.frame;
  const box = (x: number, y: number, w: number, h: number) =>
    shapeQuad(shape, helpers, x, y, w, h);
  const muted = helpers.color("--canvas-muted");
  drawRoundedRect(gpu, box(0, 0, width, height), {
    radius: 6 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-toolbar-bg")),
    stroke: parseColor(helpers.color("--canvas-doc-divider")),
    strokeWidth: helpers.scale,
  });
  const dot = parseColor(muted);
  for (let y = 6; y < height - 4; y += 4) {
    for (const x of [6, 10]) {
      drawRoundedRect(gpu, box(x, y, 1.5, 1.5), {
        radius: helpers.scale,
        fill: dot,
        alpha: 0.6,
      });
    }
  }
  const pixels = helpers.scale * helpers.dpr;
  const icon = svgImage(
    audio.paused ? PLAY_ICON : PAUSE_ICON,
    helpers.color("--canvas-text"),
    16 * pixels,
    helpers.invalidate,
  );
  if (icon) drawImage(gpu, icon, box(AUDIO_GRIP + 12, height / 2 - 8, 16, 16));
  const time = lineLayout(
    `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`,
    { face: "regular", size: 12, color: muted },
    helpers.invalidate,
  );
  if (time) {
    drawTextLayout(
      gpu,
      time,
      shapePlacement(shape, helpers, {
        x: AUDIO_GRIP + 38,
        y: (height - time.height) / 2,
      }),
    );
  }
  const track = width - AUDIO_BAR_LEFT - 12;
  const progress = Number.isFinite(audio.duration)
    ? audio.currentTime / audio.duration
    : 0;
  drawRoundedRect(gpu, box(AUDIO_BAR_LEFT, height / 2 - 2, track, 4), {
    radius: 2 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-handle-bg")),
  });
  drawRoundedRect(gpu, box(AUDIO_BAR_LEFT, height / 2 - 2, track * progress, 4), {
    radius: 2 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-doc-accent")),
  });
  // Playback moves the bar every frame; other changes repaint through events.
  audioRepaints.set(audio, helpers.invalidate);
  if (!audio.paused) helpers.requestFrame();
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

/**
 * Uploads through whatever the host supplies.
 *
 * The uploader is a parameter rather than an import so the canvas does not
 * depend on the app's upload composable — it is the same reason the six
 * host-supplied values in `CanvasHost` are properties.
 */
export type CanvasUploader = (
  file: File,
  target: { spaceId: string; documentId?: string },
) => Promise<{ url: string }>;

export interface MediaUploadOptions {
  spaceId: string;
  documentId?: string;
  uploadFile: CanvasUploader;
}

export async function uploadMediaFile(
  file: File,
  options: MediaUploadOptions,
): Promise<string> {
  const result = await options.uploadFile(file, {
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

function imageSize(src: string): Promise<{ width: number; height: number }> {
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

function videoSize(src: string): Promise<{ width: number; height: number }> {
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

function fitMediaSize(width: number, height: number) {
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
  options: MediaUploadOptions,
): Promise<CanvasShape | null> {
  const type = mediaTypeForFile(file);
  if (!type) return null;

  const src = await uploadMediaFile(file, options);
  // Audio has no intrinsic pixel size; use the player-bar default size.
  let size = CanvasAudio.defaults.size;
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
      ? CanvasVideo
      : params.type === "audio"
        ? CanvasAudio
        : CanvasImage;
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
