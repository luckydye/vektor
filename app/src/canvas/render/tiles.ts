/**
 * Tile compositing: raster content drawn at the resolution the current zoom
 * deserves — a map, a PDF page, a large plot. Contrast `render.paintRaster`,
 * which is right for anything you can just `drawImage`.
 *
 * Tiles sit in shape-local coordinates. This began as a photo editor's one-image
 * "artboard"; a shape's own frame replaces that.
 */

import type { CanvasPoint, Rect, WorldTransform } from "#canvas/runtime/geometry.ts";

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
 * projection: the canvas counter-rotates so the region lands axis-aligned.
 */
export interface CanvasTileClip {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

type TileSurface = HTMLCanvasElement | OffscreenCanvas;

// Decoded surfaces, keyed by source ImageData. `putImageData` is a
// full-resolution copy plus a canvas allocation, and compositing runs on every
// pan and zoom frame — building each surface once is why this module exists.
const tileSurfaces = new WeakMap<ImageData, TileSurface>();

function getTileSurface(image: ImageData): TileSurface {
  const cached = tileSurfaces.get(image);
  if (cached) return cached;
  const surface =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(image.width, image.height)
      : document.createElement("canvas");
  surface.width = image.width;
  surface.height = image.height;
  const surfaceCtx = surface.getContext("2d");
  if (!surfaceCtx || !("putImageData" in surfaceCtx)) {
    throw new Error("tile surface 2d context required");
  }
  surfaceCtx.putImageData(image, 0, 0);
  tileSurfaces.set(image, surface);
  return surface;
}

/** Call when replacing a tile, or its surface stays pinned. */
export function releaseTileSurface(image: ImageData | null) {
  if (image) tileSurfaces.delete(image);
}

/** Draw one tile at its screen position for a shape at `origin`. */
function drawTile(
  ctx: CanvasRenderingContext2D,
  tile: CanvasTile,
  origin: CanvasPoint,
  t: WorldTransform,
) {
  const sx = (origin.x + tile.x) * t.scale + t.dx;
  const sy = (origin.y + tile.y) * t.scale + t.dy;
  const sw = tile.width * t.scale;
  const sh = tile.height * t.scale;
  if (sw <= 0 || sh <= 0) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(getTileSurface(tile.image), sx, sy, sw, sh);
}

/** Composite back to front: a coarse tile first, then finer ones over it. */
export function compositeTiles(
  ctx: CanvasRenderingContext2D,
  /** The shape's world position — its `frame.x` / `frame.y`. */
  origin: CanvasPoint,
  tiles: readonly (CanvasTile | null)[],
  t: WorldTransform,
  clip?: CanvasTileClip | null,
): void {
  ctx.save();
  if (clip) {
    const sx = (origin.x + clip.x) * t.scale + t.dx;
    const sy = (origin.y + clip.y) * t.scale + t.dy;
    const sw = clip.width * t.scale;
    const sh = clip.height * t.scale;
    if (sw <= 0 || sh <= 0) {
      ctx.restore();
      return;
    }
    // Clipped before rotating: ctx.clip() bakes the path through the current
    // CTM, so it stays axis-aligned in screen space.
    const clipPath = new Path2D();
    clipPath.rect(sx, sy, sw, sh);
    ctx.clip(clipPath);

    if (clip.rotation !== 0) {
      const scx = sx + sw / 2;
      const scy = sy + sh / 2;
      ctx.translate(scx, scy);
      ctx.rotate(-clip.rotation);
      ctx.translate(-scx, -scy);
    }
  }
  for (const tile of tiles) {
    if (tile) drawTile(ctx, tile, origin, t);
  }
  ctx.restore();
}
