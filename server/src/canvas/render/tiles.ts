/**
 * Tile compositing: raster content drawn at the resolution the current zoom
 * deserves — a map, a PDF page, a large plot. Contrast `render.paint`,
 * which is right for anything that is just one image.
 *
 * Tiles sit in shape-local coordinates. This began as a photo editor's one-image
 * "artboard"; a shape's own frame replaces that.
 */

import { drawImage, rectQuad } from "#canvas/render/primitives.ts";
import { type CanvasGpu, releaseTexture } from "#canvas/render/webgl.ts";
import type { CanvasPoint, Rect } from "#canvas/runtime/geometry.ts";

/**
 * A raster tile in shape-local coordinates. Pixel dimensions are independent of
 * `width`/`height` — that ratio is the tile's resolution.
 */
export interface CanvasTile {
  image: ImageData;
  /** Shape-local top-left of the region this tile covers. */
  x: number;
  y: number;
  /** Shape-local extent of that region, in world units. */
  width: number;
  height: number;
}

/** The current viewport, for deciding what to rasterize. */
export interface CanvasTileView {
  /** Screen pixels per world unit. Multiply by `dpr` for device pixels. */
  scale: number;
  dpr: number;
  /** The world region currently on screen — rasterizing outside it is wasted. */
  visibleWorld: Rect;
}

/**
 * Clip in shape-local coordinates, rotation in radians. A rotated clip is a
 * projection: the tiles counter-rotate so the region lands axis-aligned.
 */
export interface CanvasTileClip {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** Call when replacing a tile, or its texture stays resident. */
export function releaseTileSurface(image: ImageData | null) {
  if (image) releaseTexture(image);
}

function rotateAbout(point: CanvasPoint, center: CanvasPoint, cos: number, sin: number) {
  const x = point.x - center.x;
  const y = point.y - center.y;
  return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos };
}

/** Composite back to front: a coarse tile first, then finer ones over it. */
export function compositeTiles(
  gpu: CanvasGpu,
  /** The shape's world position — its `frame.x` / `frame.y`. */
  origin: CanvasPoint,
  tiles: readonly (CanvasTile | null)[],
  clip: CanvasTileClip | null,
): void {
  const { gl } = gpu;
  const { transform: t, screen, dpr } = gpu.view;
  let center: CanvasPoint | null = null;
  if (clip) {
    const sx = (origin.x + clip.x) * t.scale + t.dx;
    const sy = (origin.y + clip.y) * t.scale + t.dy;
    const sw = clip.width * t.scale;
    const sh = clip.height * t.scale;
    if (sw <= 0 || sh <= 0) return;
    // The clip stays axis-aligned on screen; a rotated clip counter-rotates the
    // tiles inside it instead.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.floor(sx * dpr),
      Math.floor((screen.height - sy - sh) * dpr),
      Math.ceil(sw * dpr),
      Math.ceil(sh * dpr),
    );
    if (clip.rotation !== 0) center = { x: sx + sw / 2, y: sy + sh / 2 };
  }
  const cos = Math.cos(-(clip?.rotation ?? 0));
  const sin = Math.sin(-(clip?.rotation ?? 0));
  for (const tile of tiles) {
    if (!tile) continue;
    const quad = rectQuad(
      (origin.x + tile.x) * t.scale + t.dx,
      (origin.y + tile.y) * t.scale + t.dy,
      tile.width * t.scale,
      tile.height * t.scale,
    );
    if (quad.axisX.x <= 0 || quad.axisY.y <= 0) continue;
    drawImage(
      gpu,
      tile.image,
      center
        ? {
            origin: rotateAbout(quad.origin, center, cos, sin),
            axisX: rotateAbout(quad.axisX, { x: 0, y: 0 }, cos, sin),
            axisY: rotateAbout(quad.axisY, { x: 0, y: 0 }, cos, sin),
          }
        : quad,
    );
  }
  gl.disable(gl.SCISSOR_TEST);
}
