/**
 * The selection layer: outlines around selected strokes.
 *
 * Its own surface, and its own renderer, because selection changes on click
 * while ink changes on draw — sharing a canvas would repaint every stroke each
 * time the selection moved.
 */

import {
  drawRetainedFreehandSelection,
  type RetainedFreehandSelectionGroup,
  retainFreehandOutlines,
} from "#canvas/render/freehand.ts";
import type { CanvasStroke } from "#canvas/runtime/extensionApi.ts";
import type { ScreenSize, WorldTransform } from "#canvas/runtime/geometry.ts";

type CanvasSelectionSnapshot = {
  strokes: CanvasStroke[];
  selectedStrokeIds: Set<string>;
  remoteSelectedStrokeIds?: Array<{ ids: Set<string>; color: string }>;
  // Present for a multi-item local selection, adding one axis-aligned bounds
  // box around the individual item outlines for group transforms.
  selectionBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  selectedShapeBounds?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    type?: string;
  }>;
  remoteSelectedShapeBounds?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    type?: string;
    color: string;
  }>;
};

type CanvasSelectionRenderParams = CanvasSelectionSnapshot & {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
};

function renderCanvasSelections(params: CanvasSelectionRenderParams) {
  const {
    context,
    dpr,
    screen,
    transform,
    strokes,
    selectedStrokeIds,
    remoteSelectedStrokeIds = [],
    selectionBounds,
    selectedShapeBounds = [],
    remoteSelectedShapeBounds = [],
  } = params;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.width, screen.height);
  context.setLineDash([]);
  drawRetainedFreehandSelection(
    context,
    retainCanvasSelectionStrokes({ strokes, selectedStrokeIds }, transform),
    transform,
  );

  for (const bounds of selectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, "#2563eb");
  }

  if (selectionBounds) {
    drawShapeOutline(context, selectionBounds, transform, "#2563eb");
  }

  drawRetainedFreehandSelection(
    context,
    retainCanvasSelectionStrokes(
      { strokes, selectedStrokeIds: new Set(), remoteSelectedStrokeIds },
      transform,
    ),
    transform,
  );

  for (const bounds of remoteSelectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, bounds.color);
  }
}

// Retained Path2D geometry still makes Chromium rasterize every selected path
// for every camera frame. Cache the completed antialiased pass instead; the
// margin lets pan/zoom frames reposition it without rebuilding the paths.
const SELECTION_RASTER_MARGIN = 256;
// The selection gap is two screen pixels. A 25% scale window limits temporary
// resampling drift to roughly half a pixel while avoiding needless rebuilds.
const SELECTION_RASTER_MIN_SCALE_RATIO = 0.75;
const SELECTION_RASTER_MAX_SCALE_RATIO = 1.25;
const SELECTION_RASTER_MIN_REFRESH_MS = 50;
const SELECTION_RASTER_MAX_REFRESH_MS = 250;
const SELECTION_RASTER_BUILD_COOLDOWN = 8;

type CanvasSelectionRasterCache = {
  canvas: HTMLCanvasElement;
  dpr: number;
  screen: ScreenSize;
  viewport: ScreenSize;
  transform: WorldTransform;
  selection: CanvasSelectionSnapshot;
  remoteStrokeGroups: RetainedFreehandSelectionGroup[];
};

type CanvasSelectionRendererParams = {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  selection: CanvasSelectionSnapshot;
  refresh?: boolean;
  deferRefresh?: boolean;
};

function hasCanvasSelection(selection: CanvasSelectionSnapshot) {
  if (selection.selectionBounds) return true;
  if (selection.selectedStrokeIds.size > 0) return true;
  if ((selection.selectedShapeBounds?.length ?? 0) > 0) return true;
  if ((selection.remoteSelectedShapeBounds?.length ?? 0) > 0) return true;
  return selection.remoteSelectedStrokeIds?.some((item) => item.ids.size > 0) ?? false;
}

function retainCanvasSelectionStrokes(
  selection: Pick<
    CanvasSelectionSnapshot,
    "strokes" | "selectedStrokeIds" | "remoteSelectedStrokeIds"
  >,
  transform: WorldTransform,
) {
  const strokesById = new Map(selection.strokes.map((stroke) => [stroke.id, stroke]));
  const groups: RetainedFreehandSelectionGroup[] = [];
  const retainGroup = (ids: Set<string>, color: string) => {
    const strokes: CanvasStroke[] = [];
    for (const id of ids) {
      const stroke = strokesById.get(id);
      if (stroke) strokes.push(stroke);
    }
    const outlines = retainFreehandOutlines(strokes, transform);
    if (outlines.length > 0) groups.push({ outlines, color });
  };

  retainGroup(selection.selectedStrokeIds, "#2563eb");
  for (const remote of selection.remoteSelectedStrokeIds ?? []) {
    retainGroup(remote.ids, remote.color);
  }
  return groups;
}

class CanvasSelectionRenderer {
  #cache: CanvasSelectionRasterCache | null = null;
  #interactionOffset: { x: number; y: number } | null = null;
  #lastBuildAt = 0;
  #lastBuildDuration = 0;

  setInteractionOffset(offset: { x: number; y: number } | null) {
    this.#interactionOffset = offset ? { ...offset } : null;
  }

  render(params: CanvasSelectionRendererParams) {
    const {
      context,
      dpr,
      screen,
      transform,
      selection,
      refresh = false,
      deferRefresh = false,
    } = params;
    if (!hasCanvasSelection(selection)) {
      this.#releaseCache();
      this.#clear(context, dpr, screen);
      return;
    }

    const cache = this.#cache;
    const buildCooldown = Math.min(
      SELECTION_RASTER_MAX_REFRESH_MS,
      Math.max(
        SELECTION_RASTER_MIN_REFRESH_MS,
        this.#lastBuildDuration * SELECTION_RASTER_BUILD_COOLDOWN,
      ),
    );
    const intermediateRefreshReady =
      performance.now() - this.#lastBuildAt >= buildCooldown;
    if (deferRefresh && cache?.selection !== selection && !intermediateRefreshReady) {
      this.#draw(context, dpr, screen, transform);
      return;
    }

    const surfaceChanged =
      !cache ||
      cache.dpr !== dpr ||
      cache.viewport.width !== screen.width ||
      cache.viewport.height !== screen.height;
    const scaleRatio = cache ? transform.scale / cache.transform.scale : 1;
    const scaleDrifted =
      scaleRatio < SELECTION_RASTER_MIN_SCALE_RATIO ||
      scaleRatio > SELECTION_RASTER_MAX_SCALE_RATIO;
    const cameraNeedsRefresh =
      cache !== null &&
      ((scaleDrifted && intermediateRefreshReady) ||
        (refresh &&
          (cache.transform.scale !== transform.scale ||
            !this.#cacheCovers(cache, screen, transform))));
    const selectionChanged = cache?.selection !== selection;
    if (
      surfaceChanged ||
      !cache ||
      (selectionChanged && this.#interactionOffset === null) ||
      cameraNeedsRefresh
    ) {
      const buildStartedAt = performance.now();
      this.#cache = this.#buildCache(cache, dpr, screen, transform, selection);
      this.#lastBuildAt = performance.now();
      this.#lastBuildDuration = this.#lastBuildAt - buildStartedAt;
    }
    this.#draw(context, dpr, screen, transform);
  }

  dispose() {
    this.#releaseCache();
  }

  #draw(
    context: CanvasRenderingContext2D,
    dpr: number,
    screen: ScreenSize,
    transform: WorldTransform,
  ) {
    const cache = this.#cache;
    if (!cache) {
      this.#clear(context, dpr, screen);
      return;
    }

    this.#clear(context, dpr, screen);
    const { ratio, x, y } = this.#cachePlacement(cache, transform);
    const interactionDx = (this.#interactionOffset?.x ?? 0) * transform.scale;
    const interactionDy = (this.#interactionOffset?.y ?? 0) * transform.scale;
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      cache.canvas,
      x + interactionDx,
      y + interactionDy,
      cache.screen.width * ratio,
      cache.screen.height * ratio,
    );
    context.setLineDash([]);
    drawRetainedFreehandSelection(context, cache.remoteStrokeGroups, transform);
    for (const bounds of cache.selection.remoteSelectedShapeBounds ?? []) {
      drawShapeOutline(context, bounds, transform, bounds.color);
    }
    context.restore();
  }

  #buildCache(
    previous: CanvasSelectionRasterCache | null,
    dpr: number,
    viewport: ScreenSize,
    transform: WorldTransform,
    selection: CanvasSelectionSnapshot,
  ): CanvasSelectionRasterCache {
    const canvas = previous?.canvas ?? document.createElement("canvas");
    const screen = {
      width: viewport.width + SELECTION_RASTER_MARGIN * 2,
      height: viewport.height + SELECTION_RASTER_MARGIN * 2,
    };
    const width = Math.ceil(screen.width * dpr);
    const height = Math.ceil(screen.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const cacheContext = canvas.getContext("2d");
    if (!cacheContext) throw new Error("Selection cache requires a 2D canvas context");

    renderCanvasSelections({
      strokes: selection.strokes,
      selectedStrokeIds: selection.selectedStrokeIds,
      selectionBounds: selection.selectionBounds,
      selectedShapeBounds: selection.selectedShapeBounds,
      remoteSelectedStrokeIds: [],
      remoteSelectedShapeBounds: [],
      context: cacheContext,
      dpr,
      screen,
      transform: {
        scale: transform.scale,
        dx: transform.dx + SELECTION_RASTER_MARGIN,
        dy: transform.dy + SELECTION_RASTER_MARGIN,
      },
    });

    return {
      canvas,
      dpr,
      screen,
      viewport: { ...viewport },
      transform: { ...transform },
      selection,
      remoteStrokeGroups: retainCanvasSelectionStrokes(
        {
          strokes: selection.strokes,
          selectedStrokeIds: new Set(),
          remoteSelectedStrokeIds: selection.remoteSelectedStrokeIds,
        },
        transform,
      ),
    };
  }

  #cachePlacement(cache: CanvasSelectionRasterCache, transform: WorldTransform) {
    const ratio = transform.scale / cache.transform.scale;
    return {
      ratio,
      x: (-SELECTION_RASTER_MARGIN - cache.transform.dx) * ratio + transform.dx,
      y: (-SELECTION_RASTER_MARGIN - cache.transform.dy) * ratio + transform.dy,
    };
  }

  #cacheCovers(
    cache: CanvasSelectionRasterCache,
    screen: ScreenSize,
    transform: WorldTransform,
  ) {
    const { ratio, x, y } = this.#cachePlacement(cache, transform);
    return (
      x <= 0 &&
      y <= 0 &&
      x + cache.screen.width * ratio >= screen.width &&
      y + cache.screen.height * ratio >= screen.height
    );
  }

  #clear(context: CanvasRenderingContext2D, dpr: number, screen: ScreenSize) {
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, screen.width, screen.height);
    context.restore();
  }

  #releaseCache() {
    if (this.#cache) {
      this.#cache.canvas.width = 0;
      this.#cache.canvas.height = 0;
    }
    this.#cache = null;
    this.#interactionOffset = null;
    this.#lastBuildAt = 0;
    this.#lastBuildDuration = 0;
  }
}

export function createCanvasSelectionRenderer() {
  return new CanvasSelectionRenderer();
}

function drawShapeOutline(
  context: CanvasRenderingContext2D,
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    type?: string;
  },
  transform: WorldTransform,
  strokeStyle: string,
) {
  const expand = bounds.type === "section" ? 4 : 2;
  const sx = (bounds.x + bounds.width / 2) * transform.scale + transform.dx;
  const sy = (bounds.y + bounds.height / 2) * transform.scale + transform.dy;
  const sw = bounds.width * transform.scale + expand * 2;
  const sh = bounds.height * transform.scale + expand * 2;
  context.save();
  context.translate(sx, sy);
  context.rotate(((bounds.rotation ?? 0) * Math.PI) / 180);
  context.strokeStyle = strokeStyle;
  context.lineWidth = 1.5;
  context.beginPath();
  context.rect(-sw / 2, -sh / 2, sw, sh);
  context.stroke();
  context.restore();
}
