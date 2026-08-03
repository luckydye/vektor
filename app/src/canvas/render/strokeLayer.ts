/**
 * Ink painting: the pen's stroke style, and every surface strokes are drawn on.
 *
 * Split from the draw tool because the engine paints ink on every frame whether
 * or not the tool is active — a canvas full of strokes still renders when the
 * select tool is in hand. The tool owns the gesture; this owns the pixels.
 */

import {
  drawFreehandStroke,
  FREEHAND_STYLE,
  type FreehandStroke,
  fillFreehandStrokeMask,
  maxStrokeWidth,
  strokePointBounds,
} from "#canvas/render/freehand.ts";
import { drawSnapGuides } from "#canvas/render/snapGuides.ts";
import type { CanvasStroke } from "#canvas/runtime/extensionApi.ts";
import type { ScreenSize, SnapGuide, WorldTransform } from "#canvas/runtime/geometry.ts";

function themedStroke(stroke: FreehandStroke, defaultInkColor: string): FreehandStroke {
  if (stroke.style.color !== FREEHAND_STYLE.color) {
    return stroke;
  }

  return {
    ...stroke,
    style: {
      ...stroke.style,
      color: defaultInkColor,
    },
  };
}

type CanvasInkRenderParams = {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  strokes: CanvasStroke[];
  activeStroke: FreehandStroke | null;
  snapGuides: SnapGuide[];
  defaultInkColor: string;
};

function clearInkCanvas(
  context: CanvasRenderingContext2D,
  dpr: number,
  screen: ScreenSize,
) {
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.width, screen.height);
}

function paintCanvasStrokes(
  context: CanvasRenderingContext2D,
  strokes: CanvasStroke[],
  transform: WorldTransform,
  screen: ScreenSize,
  defaultInkColor: string,
) {
  const minX = -transform.dx / transform.scale;
  const minY = -transform.dy / transform.scale;
  const maxX = (screen.width - transform.dx) / transform.scale;
  const maxY = (screen.height - transform.dy) / transform.scale;

  for (const stroke of strokes) {
    const bounds = strokePointBounds(stroke);
    const padding = maxStrokeWidth(stroke.style);
    if (
      !bounds ||
      bounds.maxX + padding < minX ||
      bounds.minX - padding > maxX ||
      bounds.maxY + padding < minY ||
      bounds.minY - padding > maxY
    ) {
      continue;
    }
    drawFreehandStroke(context, themedStroke(stroke, defaultInkColor), transform);
  }
}

function drawCanvasInkOverlay(
  context: CanvasRenderingContext2D,
  activeStroke: FreehandStroke | null,
  snapGuides: SnapGuide[],
  transform: WorldTransform,
  screen: ScreenSize,
  defaultInkColor: string,
) {
  if (activeStroke) {
    drawFreehandStroke(context, themedStroke(activeStroke, defaultInkColor), transform);
  }
  drawSnapGuides(context, snapGuides, transform, screen, { color: "#2563eb" });
}

// Draw completed strokes into a caller-owned canvas without clearing it.
// Use this when ink shares a backing store with other canvas layers.
function drawCanvasStrokes(
  params: Pick<
    CanvasInkRenderParams,
    "context" | "screen" | "transform" | "strokes" | "defaultInkColor"
  >,
) {
  const { context, screen, transform, strokes, defaultInkColor } = params;
  paintCanvasStrokes(context, strokes, transform, screen, defaultInkColor);
}

const STATIC_INK_CACHE_MARGIN = 256;
const STATIC_INK_MIN_SCALE_RATIO = 2 / 3;
const STATIC_INK_MAX_SCALE_RATIO = 3 / 2;
const STATIC_INK_REFRESH_MARGIN = 96;
const STATIC_INK_REFRESH_MIN_SCALE_RATIO = 4 / 5;
const STATIC_INK_REFRESH_MAX_SCALE_RATIO = 5 / 4;
const STATIC_INK_REFRESH_STROKES_PER_CHUNK = 32;
const STATIC_INK_REFRESH_MAX_STROKES_PER_FRAME = 512;
const STATIC_INK_REFRESH_BUDGET_MS = 5;

type StaticInkRasterCache = {
  canvas: HTMLCanvasElement;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  strokes: CanvasStroke[];
  defaultInkColor: string;
};

type StaticInkRasterBuild = {
  cache: StaticInkRasterCache;
  nextStrokeIndex: number;
  rafId: number | null;
};

type CanvasStrokeTransform = {
  originalStrokes: CanvasStroke[];
  strokes: CanvasStroke[];
  dx: number;
  dy: number;
};

type CanvasStrokeTransformState = CanvasStrokeTransform & {
  originalCache: StaticInkRasterCache | null;
  renderedStrokes: CanvasStroke[];
  renderedDx: number;
  renderedDy: number;
};

type CanvasInkRendererOptions = {
  getDpr: () => number;
  getScreen: () => ScreenSize;
  getTransform: () => WorldTransform;
  getStrokes: () => CanvasStroke[];
  getDefaultInkColor: () => string;
  invalidateScene: () => void;
};

type StrokeBounds = { x: number; y: number; width: number; height: number };

function boundsForStroke(stroke: CanvasStroke): StrokeBounds | null {
  const bounds = strokePointBounds(stroke);
  if (!bounds) return null;
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

function maxWidthForStroke(stroke: CanvasStroke) {
  return stroke.points.reduce(
    (width, point) => Math.max(width, point.width ?? stroke.style.width),
    stroke.style.width,
  );
}

function strokeBoundsIntersect(left: StrokeBounds, right: StrokeBounds) {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

class CanvasInkRenderer {
  readonly #options: CanvasInkRendererOptions;
  #cache: StaticInkRasterCache | null = null;
  #fallbackCache: StaticInkRasterCache | null = null;
  #build: StaticInkRasterBuild | null = null;
  #spareCanvas: HTMLCanvasElement | null = null;
  #strokeTransform: CanvasStrokeTransformState | null = null;
  #committingCacheUpdate = false;

  constructor(options: CanvasInkRendererOptions) {
    this.#options = options;
  }

  get strokeTransform(): Readonly<CanvasStrokeTransform> | null {
    return this.#strokeTransform;
  }

  get isTransformingStroke() {
    return this.#strokeTransform !== null;
  }

  renderStaticInk(context: CanvasRenderingContext2D) {
    const strokes = this.#options.getStrokes();
    if (strokes.length === 0) {
      this.#cancelRasterRefresh();
      this.#cache = null;
      this.#discardFallbackCache();
      return;
    }

    const currentTransform = this.#options.getTransform();
    const color = this.#options.getDefaultInkColor();
    if (this.#fallbackCache && !this.#cacheMatches(this.#fallbackCache, color)) {
      this.#discardFallbackCache();
    }
    let cache = this.#cache;
    if (!cache || !this.#cacheSurfaceMatches(cache, color)) {
      cache = this.#buildRasterCache(currentTransform, color);
      this.#cache = cache;
    } else if (cache.strokes !== strokes) {
      if (this.#committingCacheUpdate) cache.strokes = strokes;
      else {
        cache = this.#buildRasterCache(currentTransform, color);
        this.#cache = cache;
      }
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const fallback = this.#fallbackCache;
    if (fallback && !this.#cacheFillsViewport(cache, currentTransform)) {
      this.#drawRasterCache(context, fallback, currentTransform);
    }
    this.#drawRasterCache(context, cache, currentTransform);

    if (!this.#strokeTransform && this.#cacheNeedsRefresh(cache, currentTransform)) {
      this.#scheduleRasterRefresh(currentTransform, color);
    }
  }

  beginStrokeTransform(strokes: CanvasStroke[]) {
    if (strokes.length === 0) return false;
    this.#strokeTransform = {
      originalCache: this.#cloneCacheForTransform(),
      originalStrokes: strokes,
      strokes,
      dx: 0,
      dy: 0,
      renderedStrokes: strokes,
      renderedDx: 0,
      renderedDy: 0,
    };
    return true;
  }

  setStrokeTransform(strokes: CanvasStroke[], dx = 0, dy = 0) {
    const state = this.#strokeTransform;
    if (!state) return false;
    state.strokes = strokes;
    state.dx = dx;
    state.dy = dy;
    return true;
  }

  renderStrokeTransformCache() {
    const state = this.#strokeTransform;
    const target = this.#cache;
    const source = state?.originalCache;
    if (!state || !source || !target || source.canvas === target.canvas) return false;

    if (
      !this.#restoreStrokeDamage(
        source,
        target,
        state.renderedStrokes,
        state.renderedDx,
        state.renderedDy,
      ) ||
      !this.#restoreStrokeDamage(source, target, state.originalStrokes, 0, 0)
    ) {
      return false;
    }

    const moved =
      state.dx !== 0 ||
      state.dy !== 0 ||
      state.strokes.some((stroke, index) => stroke !== state.originalStrokes[index]);
    if (moved) {
      this.#eraseTransformedStrokes(state.originalStrokes);
      this.#updateCacheStrokes(
        state.strokes,
        { dx: state.dx, dy: state.dy },
        "source-over",
      );
    }
    state.renderedStrokes = state.strokes;
    state.renderedDx = state.dx;
    state.renderedDy = state.dy;
    this.#options.invalidateScene();
    return true;
  }

  cancelStrokeTransform() {
    const state = this.#strokeTransform;
    if (!state) return false;
    if (state.originalCache && this.#cache) {
      const modifiedCanvas = this.#cache.canvas;
      this.#cache = state.originalCache;
      this.#spareCanvas = modifiedCanvas;
    }
    this.#strokeTransform = null;
    return true;
  }

  commitAddedStroke(stroke: CanvasStroke, commit: () => void) {
    const cacheUpdated = this.#updateCacheStrokes(
      [stroke],
      { dx: 0, dy: 0 },
      "source-over",
    );
    this.#withCacheCommit(cacheUpdated, commit);
  }

  /**
   * Incrementally paints newly added strokes into the raster cache and adopts
   * the updated stroke list inside `commit`, so a batch of additions (e.g.
   * strokes streamed in from a collaborator) reuses the existing cache instead
   * of forcing a full rebuild. Falls back to a rebuild if the cache can't be
   * patched (missing/mismatched surface).
   */
  commitAddedStrokes(strokes: CanvasStroke[], commit: () => void) {
    const cacheUpdated =
      strokes.length > 0 &&
      this.#updateCacheStrokes(strokes, { dx: 0, dy: 0 }, "source-over");
    this.#withCacheCommit(cacheUpdated, commit);
  }

  /**
   * True while a caller-driven cache commit is in flight. Lets the stroke sync
   * detect that the cache was already patched by the initiator (a local draw)
   * and avoid patching the same strokes twice.
   */
  get isCommittingCacheUpdate() {
    return this.#committingCacheUpdate;
  }

  commitStrokeTransform(commit: (state: Readonly<CanvasStrokeTransform>) => void) {
    const state = this.#strokeTransform;
    if (!state) return false;
    const cacheUpdated = this.renderStrokeTransformCache();
    this.#withCacheCommit(cacheUpdated, () => commit(state));
    this.#strokeTransform = null;
    return true;
  }

  dispose() {
    this.#cancelRasterRefresh();
    this.#discardFallbackCache();
  }

  #withCacheCommit(cacheUpdated: boolean, commit: () => void) {
    this.#committingCacheUpdate = cacheUpdated;
    try {
      commit();
    } finally {
      this.#committingCacheUpdate = false;
    }
  }

  #cacheMatches(cache: StaticInkRasterCache, color: string) {
    return (
      cache.strokes === this.#options.getStrokes() &&
      this.#cacheSurfaceMatches(cache, color)
    );
  }

  #cacheSurfaceMatches(cache: StaticInkRasterCache, color: string) {
    const screen = this.#options.getScreen();
    return !(
      cache.dpr !== this.#options.getDpr() ||
      cache.defaultInkColor !== color ||
      cache.screen.width !== screen.width + STATIC_INK_CACHE_MARGIN * 2 ||
      cache.screen.height !== screen.height + STATIC_INK_CACHE_MARGIN * 2
    );
  }

  #cachePlacement(cache: StaticInkRasterCache, transform: WorldTransform) {
    const ratio = transform.scale / cache.transform.scale;
    const x = (-STATIC_INK_CACHE_MARGIN - cache.transform.dx) * ratio + transform.dx;
    const y = (-STATIC_INK_CACHE_MARGIN - cache.transform.dy) * ratio + transform.dy;
    return { ratio, x, y };
  }

  #drawRasterCache(
    context: CanvasRenderingContext2D,
    cache: StaticInkRasterCache,
    transform: WorldTransform,
  ) {
    const { ratio, x, y } = this.#cachePlacement(cache, transform);
    context.drawImage(
      cache.canvas,
      x,
      y,
      cache.screen.width * ratio,
      cache.screen.height * ratio,
    );
  }

  #cacheFillsViewport(cache: StaticInkRasterCache, transform: WorldTransform) {
    const { ratio, x, y } = this.#cachePlacement(cache, transform);
    const screen = this.#options.getScreen();
    return (
      x <= 0 &&
      y <= 0 &&
      x + cache.screen.width * ratio >= screen.width &&
      y + cache.screen.height * ratio >= screen.height
    );
  }

  #cacheCovers(cache: StaticInkRasterCache, transform: WorldTransform, color: string) {
    if (!this.#cacheMatches(cache, color)) return false;

    const { ratio, x, y } = this.#cachePlacement(cache, transform);
    if (ratio < STATIC_INK_MIN_SCALE_RATIO || ratio > STATIC_INK_MAX_SCALE_RATIO) {
      return false;
    }
    const screen = this.#options.getScreen();
    return (
      x <= 0 &&
      y <= 0 &&
      x + cache.screen.width * ratio >= screen.width &&
      y + cache.screen.height * ratio >= screen.height
    );
  }

  #cacheNeedsRefresh(cache: StaticInkRasterCache, transform: WorldTransform) {
    const screen = this.#options.getScreen();
    const { ratio, x, y } = this.#cachePlacement(cache, transform);
    const right = x + cache.screen.width * ratio - screen.width;
    const bottom = y + cache.screen.height * ratio - screen.height;
    return (
      ratio < STATIC_INK_REFRESH_MIN_SCALE_RATIO ||
      ratio > STATIC_INK_REFRESH_MAX_SCALE_RATIO ||
      -x < STATIC_INK_REFRESH_MARGIN ||
      -y < STATIC_INK_REFRESH_MARGIN ||
      right < STATIC_INK_REFRESH_MARGIN ||
      bottom < STATIC_INK_REFRESH_MARGIN
    );
  }

  #prepareRasterCache(
    transform: WorldTransform,
    color: string,
    canvas: HTMLCanvasElement,
  ): StaticInkRasterCache {
    const screen = this.#options.getScreen();
    const dpr = this.#options.getDpr();
    const cacheScreen = {
      width: screen.width + STATIC_INK_CACHE_MARGIN * 2,
      height: screen.height + STATIC_INK_CACHE_MARGIN * 2,
    };
    const width = Math.ceil(cacheScreen.width * dpr);
    const height = Math.ceil(cacheScreen.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Static ink cache requires a 2D canvas context");

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cacheScreen.width, cacheScreen.height);
    return {
      canvas,
      dpr,
      screen: cacheScreen,
      transform: { ...transform },
      strokes: this.#options.getStrokes(),
      defaultInkColor: color,
    };
  }

  #paintRasterCache(
    cache: StaticInkRasterCache,
    strokes: CanvasStroke[],
    offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
  ) {
    const context = cache.canvas.getContext("2d");
    if (!context) throw new Error("Static ink cache requires a 2D canvas context");
    context.save();
    // Damage copies use device-pixel coordinates and temporarily install the
    // identity transform. Stroke paint must never inherit that canvas state.
    context.setTransform(cache.dpr, 0, 0, cache.dpr, 0, 0);
    context.globalAlpha = 1;
    drawCanvasStrokes({
      context,
      screen: cache.screen,
      transform: {
        scale: cache.transform.scale,
        dx:
          cache.transform.dx +
          STATIC_INK_CACHE_MARGIN +
          offset.dx * cache.transform.scale,
        dy:
          cache.transform.dy +
          STATIC_INK_CACHE_MARGIN +
          offset.dy * cache.transform.scale,
      },
      strokes,
      defaultInkColor: cache.defaultInkColor,
    });
    context.restore();
  }

  #prepareSpareCanvas(cache: StaticInkRasterCache) {
    if (!this.#spareCanvas) this.#spareCanvas = document.createElement("canvas");
    const width = Math.ceil(cache.screen.width * cache.dpr);
    const height = Math.ceil(cache.screen.height * cache.dpr);
    if (this.#spareCanvas.width !== width) this.#spareCanvas.width = width;
    if (this.#spareCanvas.height !== height) this.#spareCanvas.height = height;
    this.#spareCanvas.getContext("2d");
  }

  #cancelRasterRefresh() {
    const build = this.#build;
    if (!build) return;
    if (build.rafId !== null) cancelAnimationFrame(build.rafId);
    this.#spareCanvas = build.cache.canvas;
    this.#build = null;
  }

  #buildRasterCache(transform: WorldTransform, color: string) {
    this.#cancelRasterRefresh();
    this.#discardFallbackCache();
    const canvas = this.#cache?.canvas ?? document.createElement("canvas");
    const cache = this.#prepareRasterCache(transform, color, canvas);
    this.#paintRasterCache(cache, cache.strokes);
    this.#prepareSpareCanvas(cache);
    return cache;
  }

  #scheduleRasterRefresh(transform: WorldTransform, color: string) {
    if (this.#build && this.#cacheCovers(this.#build.cache, transform, color)) {
      return;
    }
    this.#cancelRasterRefresh();

    const canvas = this.#spareCanvas ?? document.createElement("canvas");
    this.#spareCanvas = null;
    this.#build = {
      cache: this.#prepareRasterCache(transform, color, canvas),
      nextStrokeIndex: 0,
      rafId: requestAnimationFrame(() => this.#paintRasterRefreshBatch()),
    };
  }

  #paintRasterRefreshBatch() {
    const build = this.#build;
    if (!build) return;
    build.rafId = null;

    const startedAt = performance.now();
    const maxEnd = Math.min(
      build.nextStrokeIndex + STATIC_INK_REFRESH_MAX_STROKES_PER_FRAME,
      build.cache.strokes.length,
    );
    let end = build.nextStrokeIndex;
    do {
      const chunkEnd = Math.min(end + STATIC_INK_REFRESH_STROKES_PER_CHUNK, maxEnd);
      this.#paintRasterCache(build.cache, build.cache.strokes.slice(end, chunkEnd));
      end = chunkEnd;
    } while (
      end < maxEnd &&
      performance.now() - startedAt < STATIC_INK_REFRESH_BUDGET_MS
    );
    build.nextStrokeIndex = end;

    if (end < build.cache.strokes.length) {
      build.rafId = requestAnimationFrame(() => this.#paintRasterRefreshBatch());
      return;
    }

    const color = this.#options.getDefaultInkColor();
    if (this.#cacheCovers(build.cache, this.#options.getTransform(), color)) {
      const previousCache = this.#cache;
      this.#cache = build.cache;
      this.#retainFallbackCache(previousCache, color);
    } else {
      this.#spareCanvas = build.cache.canvas;
    }
    this.#build = null;
    this.#options.invalidateScene();
  }

  #updateCacheStrokes(
    strokes: CanvasStroke[],
    offset: { dx: number; dy: number },
    operation: GlobalCompositeOperation,
  ) {
    const cache = this.#cache;
    if (!cache || !this.#cacheMatches(cache, this.#options.getDefaultInkColor())) {
      return false;
    }
    this.#discardFallbackCache();
    this.#cancelRasterRefresh();
    const context = cache.canvas.getContext("2d");
    if (!context) return false;
    context.save();
    context.setTransform(cache.dpr, 0, 0, cache.dpr, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = operation;
    if (operation === "destination-out") {
      const cacheTransform = {
        scale: cache.transform.scale,
        dx:
          cache.transform.dx +
          STATIC_INK_CACHE_MARGIN +
          offset.dx * cache.transform.scale,
        dy:
          cache.transform.dy +
          STATIC_INK_CACHE_MARGIN +
          offset.dy * cache.transform.scale,
      };
      for (const stroke of strokes) {
        fillFreehandStrokeMask(context, stroke, cacheTransform, 1.5);
      }
    } else {
      this.#paintRasterCache(cache, strokes, offset);
    }
    context.restore();
    return true;
  }

  #retainFallbackCache(previousCache: StaticInkRasterCache | null, color: string) {
    if (!previousCache) return;
    const existingFallback = this.#fallbackCache;
    const keepExisting =
      existingFallback !== null &&
      this.#cacheMatches(existingFallback, color) &&
      existingFallback.transform.scale <= previousCache.transform.scale;
    this.#fallbackCache = keepExisting ? existingFallback : previousCache;
    const reusableCanvas = keepExisting ? previousCache.canvas : existingFallback?.canvas;
    if (reusableCanvas) this.#spareCanvas = reusableCanvas;
  }

  #discardFallbackCache() {
    const fallback = this.#fallbackCache;
    if (!fallback) return;
    this.#fallbackCache = null;
    if (
      !this.#spareCanvas &&
      fallback.canvas !== this.#cache?.canvas &&
      fallback.canvas !== this.#build?.cache.canvas
    ) {
      this.#spareCanvas = fallback.canvas;
      return;
    }
    fallback.canvas.width = 0;
    fallback.canvas.height = 0;
  }

  #cloneCacheForTransform() {
    const source = this.#cache;
    if (!source || !this.#cacheMatches(source, this.#options.getDefaultInkColor())) {
      return null;
    }
    this.#cancelRasterRefresh();

    const canvas = this.#spareCanvas ?? document.createElement("canvas");
    this.#spareCanvas = null;
    if (canvas.width !== source.canvas.width) canvas.width = source.canvas.width;
    if (canvas.height !== source.canvas.height) canvas.height = source.canvas.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "copy";
    context.drawImage(source.canvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.setTransform(source.dpr, 0, 0, source.dpr, 0, 0);

    this.#cache = { ...source, canvas };
    this.#spareCanvas = source.canvas;
    return source;
  }

  #eraseTransformedStrokes(strokes: CanvasStroke[]) {
    const cache = this.#cache;
    if (!cache) return;
    this.#updateCacheStrokes(strokes, { dx: 0, dy: 0 }, "destination-out");
    const movedIds = new Set(strokes.map((stroke) => stroke.id));
    const repairBounds = strokes.flatMap((stroke) => {
      const bounds = boundsForStroke(stroke);
      if (!bounds) return [];
      const padding =
        Math.max(maxWidthForStroke(stroke), maxStrokeWidth(stroke.style)) / 2 +
        2 / cache.transform.scale;
      return [
        {
          x: bounds.x - padding,
          y: bounds.y - padding,
          width: bounds.width + padding * 2,
          height: bounds.height + padding * 2,
        },
      ];
    });
    const overlappingStrokes = this.#options.getStrokes().filter((stroke) => {
      if (movedIds.has(stroke.id)) return false;
      const bounds = boundsForStroke(stroke);
      if (!bounds) return false;
      const padding = maxWidthForStroke(stroke) / 2;
      const paintedBounds = {
        x: bounds.x - padding,
        y: bounds.y - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
      };
      return repairBounds.some((region) => strokeBoundsIntersect(region, paintedBounds));
    });
    if (overlappingStrokes.length === 0) return;

    const context = cache.canvas.getContext("2d");
    if (!context) return;
    context.save();
    context.setTransform(cache.dpr, 0, 0, cache.dpr, 0, 0);
    context.beginPath();
    for (const bounds of repairBounds) {
      context.rect(
        bounds.x * cache.transform.scale + cache.transform.dx + STATIC_INK_CACHE_MARGIN,
        bounds.y * cache.transform.scale + cache.transform.dy + STATIC_INK_CACHE_MARGIN,
        bounds.width * cache.transform.scale,
        bounds.height * cache.transform.scale,
      );
    }
    context.clip();
    this.#updateCacheStrokes(overlappingStrokes, { dx: 0, dy: 0 }, "source-over");
    context.restore();
  }

  #restoreStrokeDamage(
    source: StaticInkRasterCache,
    target: StaticInkRasterCache,
    strokes: CanvasStroke[],
    dx: number,
    dy: number,
  ) {
    const context = target.canvas.getContext("2d");
    if (!context) return false;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    for (const stroke of strokes) {
      const bounds = boundsForStroke(stroke);
      if (!bounds) continue;
      const padding =
        Math.max(maxWidthForStroke(stroke), maxStrokeWidth(stroke.style)) / 2 +
        4 / source.transform.scale;
      const left =
        (bounds.x + dx - padding) * source.transform.scale +
        source.transform.dx +
        STATIC_INK_CACHE_MARGIN;
      const top =
        (bounds.y + dy - padding) * source.transform.scale +
        source.transform.dy +
        STATIC_INK_CACHE_MARGIN;
      const right =
        (bounds.x + dx + bounds.width + padding) * source.transform.scale +
        source.transform.dx +
        STATIC_INK_CACHE_MARGIN;
      const bottom =
        (bounds.y + dy + bounds.height + padding) * source.transform.scale +
        source.transform.dy +
        STATIC_INK_CACHE_MARGIN;
      const x = Math.max(0, Math.floor(left * source.dpr));
      const y = Math.max(0, Math.floor(top * source.dpr));
      const endX = Math.min(source.canvas.width, Math.ceil(right * source.dpr));
      const endY = Math.min(source.canvas.height, Math.ceil(bottom * source.dpr));
      const width = endX - x;
      const height = endY - y;
      if (width <= 0 || height <= 0) continue;
      context.clearRect(x, y, width, height);
      context.drawImage(source.canvas, x, y, width, height, x, y, width, height);
    }
    context.restore();
    return true;
  }
}

export function createCanvasInkRenderer(options: CanvasInkRendererOptions) {
  return new CanvasInkRenderer(options);
}

export function renderCanvasInkOverlay(
  params: Pick<
    CanvasInkRenderParams,
    | "context"
    | "dpr"
    | "screen"
    | "transform"
    | "activeStroke"
    | "snapGuides"
    | "defaultInkColor"
  >,
) {
  const { context, dpr, screen, transform, activeStroke, snapGuides, defaultInkColor } =
    params;
  clearInkCanvas(context, dpr, screen);
  drawCanvasInkOverlay(
    context,
    activeStroke,
    snapGuides,
    transform,
    screen,
    defaultInkColor,
  );
}
