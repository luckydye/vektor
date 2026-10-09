/**
 * Looping, muted videos painted with WebGL. Each src plays in one detached
 * `<video>` shared by every painter, and pauses once nothing has painted it.
 */

import { sameOriginMediaUrl } from "#canvas/render/imageSource.ts";
import { drawTexture, type ScreenQuad } from "#canvas/render/primitives.ts";
import type { CanvasGpu } from "#canvas/render/webgl.ts";

interface VideoStream {
  video: HTMLVideoElement;
  // Counts presented frames; 0 until the first one.
  frame: number;
  paintedAt: number;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  // Repaints for whoever drew the video since its last frame.
  waiting: Set<() => void>;
}

const streams = new Map<string, VideoStream>();

function streamFor(src: string): VideoStream {
  const existing = streams.get(src);
  if (existing) return existing;
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.src = sameOriginMediaUrl(src);
  const stream: VideoStream = {
    video,
    frame: 0,
    paintedAt: 0,
    pauseTimer: null,
    waiting: new Set(),
  };
  const onFrame = () => {
    stream.frame++;
    for (const invalidate of stream.waiting) invalidate();
    stream.waiting.clear();
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  streams.set(src, stream);
  return stream;
}

function play(video: HTMLVideoElement) {
  video.play().catch((error: unknown) => {
    // A pause() interrupting a pending play() is expected.
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  });
}

function pauseWhenIdle(stream: VideoStream, delay: number) {
  stream.pauseTimer = setTimeout(() => {
    const idle = performance.now() - stream.paintedAt;
    if (idle < 1000) return pauseWhenIdle(stream, 1000 - idle);
    stream.pauseTimer = null;
    stream.video.pause();
  }, delay);
}

/**
 * A texture owned by `owner` whose pixels change in place: `source` is
 * re-uploaded (premultiplied, no mipmaps) whenever `revision` changes.
 */
export function streamTexture(
  gpu: CanvasGpu,
  owner: object,
  source: TexImageSource,
  revision: number,
): WebGLTexture {
  const { gl } = gpu;
  let entry = gpu.resources.objects.get(owner) as
    | { texture: WebGLTexture; revision: number }
    | undefined;
  if (!entry) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry = { texture, revision: Number.NaN };
    gpu.resources.objects.set(owner, entry);
  }
  if (entry.revision !== revision) {
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    entry.revision = revision;
  }
  return entry.texture;
}

/** The centred part of `quad` a `width`×`height` picture fills with object-fit: contain. */
export function containQuad(quad: ScreenQuad, width: number, height: number): ScreenQuad {
  const boxWidth = Math.hypot(quad.axisX.x, quad.axisX.y);
  const boxHeight = Math.hypot(quad.axisY.x, quad.axisY.y);
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const fx = (width * scale) / boxWidth;
  const fy = (height * scale) / boxHeight;
  return {
    origin: {
      x: quad.origin.x + (quad.axisX.x * (1 - fx) + quad.axisY.x * (1 - fy)) / 2,
      y: quad.origin.y + (quad.axisX.y * (1 - fx) + quad.axisY.y * (1 - fy)) / 2,
    },
    axisX: { x: quad.axisX.x * fx, y: quad.axisX.y * fx },
    axisY: { x: quad.axisY.x * fy, y: quad.axisY.y * fy },
  };
}

/**
 * Draws the current frame of a muted, looping `src` contained in `quad`, and
 * calls `invalidate` on its next frame. Returns false before the first frame.
 */
export function drawVideo(
  gpu: CanvasGpu,
  src: string,
  quad: ScreenQuad,
  invalidate: () => void,
): boolean {
  const stream = streamFor(src);
  const { video } = stream;
  stream.paintedAt = performance.now();
  stream.waiting.add(invalidate);
  if (video.paused) play(video);
  if (!stream.pauseTimer) pauseWhenIdle(stream, 1000);
  if (stream.frame === 0 || video.videoWidth === 0 || video.videoHeight === 0)
    return false;
  drawTexture(
    gpu,
    streamTexture(gpu, video, video, stream.frame),
    containQuad(quad, video.videoWidth, video.videoHeight),
  );
  return true;
}
