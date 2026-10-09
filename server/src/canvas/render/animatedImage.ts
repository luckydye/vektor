/**
 * Animated images (GIFs) decoded frame by frame with ImageDecoder. Frames only
 * advance while painted: each paint schedules at most one repaint per image.
 */

import { sameOriginMediaUrl } from "#canvas/render/imageSource.ts";
import { drawTexture, type ScreenQuad } from "#canvas/render/primitives.ts";
import { streamTexture } from "#canvas/render/video.ts";
import type { CanvasGpu } from "#canvas/render/webgl.ts";

/** ImageDecoder is missing in Safari, where animated images cannot animate. */
export const animatesImages = typeof ImageDecoder === "function";

interface AnimatedImage {
  decoder: ImageDecoder | null;
  frameCount: number;
  // Index of the frame to decode next.
  index: number;
  shown: VideoFrame | null;
  // Bumped whenever `shown` is replaced, to re-upload the texture.
  revision: number;
  next: VideoFrame | null;
  decoding: boolean;
  dueAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const animations = new Map<string, AnimatedImage>();

async function load(animation: AnimatedImage, src: string) {
  const response = await fetch(sameOriginMediaUrl(src));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const decoder = new ImageDecoder({ data: await response.arrayBuffer(), type });
  await decoder.completed;
  const track = decoder.tracks.selectedTrack;
  if (!track) throw new Error(`No image track in ${src}`);
  animation.frameCount = track.frameCount;
  animation.decoder = decoder;
}

function animationFor(src: string, invalidate: () => void): AnimatedImage {
  const existing = animations.get(src);
  if (existing) return existing;
  const animation: AnimatedImage = {
    decoder: null,
    frameCount: 0,
    index: 0,
    shown: null,
    revision: 0,
    next: null,
    decoding: false,
    dueAt: 0,
    timer: null,
  };
  animations.set(src, animation);
  void load(animation, src).then(invalidate);
  return animation;
}

function decodeNext(
  animation: AnimatedImage,
  decoder: ImageDecoder,
  invalidate: () => void,
) {
  animation.decoding = true;
  void decoder.decode({ frameIndex: animation.index }).then(({ image }) => {
    animation.decoding = false;
    animation.next = image;
    animation.index = (animation.index + 1) % animation.frameCount;
    if (!animation.shown || performance.now() >= animation.dueAt) invalidate();
  });
}

// Browsers play GIF delays of 10ms or less at 100ms.
function frameDelay(frame: VideoFrame) {
  const ms = (frame.duration ?? 0) / 1000;
  return ms <= 10 ? 100 : ms;
}

/**
 * Draws the current frame of the animated image at `src` into `quad`, and
 * schedules the repaint for its next frame. Returns false until decoded.
 */
export function drawAnimatedImage(
  gpu: CanvasGpu,
  src: string,
  quad: ScreenQuad,
  invalidate: () => void,
): boolean {
  const animation = animationFor(src, invalidate);
  const { decoder } = animation;
  if (!decoder) return false;
  const now = performance.now();
  if (animation.next && (!animation.shown || now >= animation.dueAt)) {
    animation.shown?.close();
    animation.shown = animation.next;
    animation.next = null;
    animation.revision++;
    animation.dueAt = now + frameDelay(animation.shown);
  }
  const animates = animation.frameCount > 1;
  if ((animates || !animation.shown) && !animation.next && !animation.decoding) {
    decodeNext(animation, decoder, invalidate);
  }
  if (!animation.shown) return false;
  // An overdue frame is repainted by its decode instead, so this never spins.
  if (animates && !animation.timer && now < animation.dueAt) {
    animation.timer = setTimeout(() => {
      animation.timer = null;
      invalidate();
    }, animation.dueAt - now);
  }
  drawTexture(
    gpu,
    streamTexture(gpu, animation, animation.shown, animation.revision),
    quad,
  );
  return true;
}
