import { ref } from "vue";
import * as Y from "yjs";
import { canvasPenIcon, pencilIcon } from "#assets/icons.ts";
import type { TranslationKey } from "#utils/lang.ts";
import {
  buildFreehandStroke,
  createFreehandStrokeBuilder,
  drawRetainedFreehandSelection,
  drawFreehandStroke,
  drawSnapGuides,
  fillFreehandStrokeMask,
  type FreehandPoint,
  type FreehandStroke,
  type FreehandStrokeBuilder,
  type FreehandStrokeOptions,
  type FreehandStrokeStyle,
  type RetainedFreehandSelectionGroup,
  type ScreenSize,
  type SnapGuide,
  type WorldTransform,
  retainFreehandOutlines,
} from "../viewport/index.ts";
import type {
  CanvasPointerGestureSample,
  CanvasStroke,
  CanvasStrokeSnapshot,
  CanvasToolExtension,
} from "./types.ts";

export type DrawStrokeMode = "pencil" | "pen";
export type CanvasDrawingSession = {
  pointerId: number;
  builder: FreehandStrokeBuilder;
  mode: DrawStrokeMode;
};

export const FREEHAND_STYLE: FreehandStrokeStyle = {
  color: "#111827",
  width: 10,
  opacity: 1,
  lineCap: "round",
  lineJoin: "round",
};

// Width bounds are in world units; the renderer scales them by zoom. Pen mode
// intentionally has a broad range so velocity and stylus pressure read clearly.
const FREEHAND_PEN_VELOCITY = {
  minWidth: 2,
  maxWidth: 18,
  smoothing: 0.45,
};

// The stroke reaches its thinnest at roughly this pointer speed in screen px/ms.
const SCREEN_VELOCITY_FULL = 2.4;

export const PEN_COLORS = [
  "#111827",
  "#ef4444",
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
] as const;

export const DRAW_STROKE_MODES: Array<{
  id: DrawStrokeMode;
  label: TranslationKey;
  icon: string;
}> = [
  {
    id: "pencil",
    label: "Pencil",
    icon: pencilIcon,
  },
  {
    id: "pen",
    label: "Pen",
    icon: canvasPenIcon,
  },
];

// Tool-specific UI state belongs to the extension. Canvas.vue only binds its
// toolbar controls to this ref.
export const activeDrawStrokeMode = ref<DrawStrokeMode>("pen");

// addVelocityWidths measures velocity in world units/ms, so it would otherwise
// taper differently depending on zoom. Multiplying the scale by the current
// world->screen scale makes the taper track on-screen pointer speed instead.
export function createFreehandOptions(
  style: FreehandStrokeStyle = FREEHAND_STYLE,
  mode: DrawStrokeMode = "pen",
  worldToScreenScale = 1,
): FreehandStrokeOptions {
  return {
    minDistance: 2,
    simplifyTolerance: 0.75,
    smoothing: 0.9,
    style,
    velocityWidth:
      mode === "pen"
        ? {
            ...FREEHAND_PEN_VELOCITY,
            scale: (1 / SCREEN_VELOCITY_FULL) * worldToScreenScale,
          }
        : undefined,
  };
}

export function isFreehandPoint(value: unknown): value is FreehandPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FreehandPoint).x === "number" &&
    typeof (value as FreehandPoint).y === "number"
  );
}

export function cloneFreehandPoint(point: FreehandPoint): FreehandPoint {
  return {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
    time: point.time,
    velocity: point.velocity,
    width: point.width,
  };
}

export function strokeStyleFromUnknown(value: unknown): FreehandStrokeStyle {
  return typeof value === "object" && value !== null
    ? { ...FREEHAND_STYLE, ...(value as Partial<FreehandStrokeStyle>) }
    : { ...FREEHAND_STYLE };
}

export function createStrokeMap(stroke: CanvasStrokeSnapshot) {
  const map = new Y.Map<unknown>();
  map.set("points", stroke.points.map(cloneFreehandPoint));
  map.set("style", { ...stroke.style });
  if (stroke.kind === "shape") map.set("kind", "shape");
  if (typeof stroke.rotation === "number") map.set("rotation", stroke.rotation);
  if (stroke.authorId) map.set("authorId", stroke.authorId);
  if (stroke.locked) map.set("locked", true);
  map.set("updatedAt", stroke.updatedAt);
  return map;
}

export function toCanvasStroke(
  id: string,
  source: Y.Map<unknown> | CanvasStrokeSnapshot,
  worldToScreenScale = 1,
): CanvasStroke {
  const read = (key: keyof CanvasStrokeSnapshot) =>
    source instanceof Y.Map ? source.get(key) : source[key];
  const pointsValue = read("points");
  const points = Array.isArray(pointsValue)
    ? pointsValue.filter(isFreehandPoint).map(cloneFreehandPoint)
    : [];
  const style = strokeStyleFromUnknown(read("style"));
  const authorId = read("authorId");

  // Persisted points already carry the widths computed while drawing.
  // Recomputing velocity widths here would depend on the viewer's current zoom
  // and on the pre-layout 1x1 screen during initial load, so only derive widths
  // when none were stored.
  const options = createFreehandOptions(style, "pen", worldToScreenScale);
  if (points.some((point) => point.width !== undefined)) {
    options.velocityWidth = undefined;
  }
  const stroke = buildFreehandStroke(points, options);
  return {
    id,
    kind: read("kind") === "shape" ? "shape" : undefined,
    rotation:
      typeof read("rotation") === "number" && Number.isFinite(read("rotation"))
        ? Number(read("rotation"))
        : undefined,
    authorId: typeof authorId === "string" ? authorId : undefined,
    locked: read("locked") === true || undefined,
    updatedAt:
      typeof read("updatedAt") === "number" && Number.isFinite(read("updatedAt"))
        ? Number(read("updatedAt"))
        : Date.now(),
    ...stroke,
  };
}

function distanceToSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

type StrokePointBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

// Strokes are immutable render snapshots. Cache their point extents so hover
// hit-testing does not walk every point of every stroke before it can reject a
// far-away stroke.
const strokePointBounds = new WeakMap<CanvasStroke, StrokePointBounds | null>();

function pointBoundsForStroke(stroke: CanvasStroke): StrokePointBounds | null {
  const cached = strokePointBounds.get(stroke);
  if (cached !== undefined) return cached;
  if (stroke.points.length === 0) {
    strokePointBounds.set(stroke, null);
    return null;
  }

  let minX = stroke.points[0].x;
  let minY = stroke.points[0].y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < stroke.points.length; index += 1) {
    const point = stroke.points[index];
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const bounds = { minX, minY, maxX, maxY };
  strokePointBounds.set(stroke, bounds);
  return bounds;
}

export function hitTestCanvasStroke(
  strokes: CanvasStroke[],
  world: { x: number; y: number },
  worldToScreenScale: number,
): string | null {
  const scale = worldToScreenScale || 1;
  // Search topmost (last drawn) first.
  for (let i = strokes.length - 1; i >= 0; i -= 1) {
    const stroke = strokes[i];
    const points = stroke.points;
    const threshold = stroke.style.width / 2 + 8 / scale;
    const bounds = pointBoundsForStroke(stroke);
    if (
      !bounds ||
      world.x < bounds.minX - threshold ||
      world.x > bounds.maxX + threshold ||
      world.y < bounds.minY - threshold ||
      world.y > bounds.maxY + threshold
    ) {
      continue;
    }
    if (points.length === 1) {
      if (Math.hypot(world.x - points[0].x, world.y - points[0].y) <= threshold) {
        return stroke.id;
      }
      continue;
    }
    for (let j = 1; j < points.length; j += 1) {
      if (distanceToSegment(world, points[j - 1], points[j]) <= threshold) {
        return stroke.id;
      }
    }
  }
  return null;
}

function freehandPointFromPointerEvent(
  event: PointerEvent,
  world: { x: number; y: number },
  mode: DrawStrokeMode,
): FreehandPoint {
  // Only trust pressure from a stylus. Mice report a constant 0.5 while a button
  // is held, and touch rarely reports meaningful pressure, so for those inputs
  // width falls back to velocity-based tapering.
  const hasStylusPressure =
    mode === "pen" && event.pointerType === "pen" && event.pressure > 0;
  return {
    x: world.x,
    y: world.y,
    pressure: hasStylusPressure ? event.pressure : undefined,
    time: event.timeStamp,
  };
}

export function startCanvasDrawingStroke(
  event: PointerEvent,
  world: { x: number; y: number },
  options: {
    color: string;
    mode: DrawStrokeMode;
    worldToScreenScale: number;
  },
): { session: CanvasDrawingSession; stroke: FreehandStroke } | null {
  if (event.button !== 0 || (event.pointerType === "touch" && !event.isPrimary)) {
    return null;
  }

  const builder = createFreehandStrokeBuilder(
    createFreehandOptions(
      { ...FREEHAND_STYLE, color: options.color },
      options.mode,
      options.worldToScreenScale,
    ),
  );
  return {
    session: {
      pointerId: event.pointerId,
      builder,
      mode: options.mode,
    },
    stroke: builder.startAt(freehandPointFromPointerEvent(event, world, options.mode)),
  };
}

export function addCanvasDrawingPoint(
  session: CanvasDrawingSession,
  event: PointerEvent,
  world: { x: number; y: number },
): FreehandStroke | null {
  if (session.pointerId !== event.pointerId) return null;
  return session.builder.addPoint(
    freehandPointFromPointerEvent(event, world, session.mode),
  );
}

export function addCanvasDrawingPoints(
  session: CanvasDrawingSession,
  samples: readonly Pick<CanvasPointerGestureSample, "event" | "world">[],
): FreehandStroke | null {
  function* points(): Iterable<FreehandPoint> {
    for (const { event, world } of samples) {
      if (session.pointerId !== event.pointerId) continue;
      yield freehandPointFromPointerEvent(event, world, session.mode);
    }
  }

  return session.builder.addPoints(points());
}

export function finishCanvasDrawingStroke(
  session: CanvasDrawingSession,
): CanvasStrokeSnapshot | null {
  const finished = session.builder.finish();
  if (finished.points.length === 0) return null;
  return {
    id: `stroke-${crypto.randomUUID()}`,
    points: finished.points.map(cloneFreehandPoint),
    style: { ...finished.style },
    updatedAt: Date.now(),
  };
}

// Freehand drawing is a regular extension-owned pointer gesture. The host only
// supplies coordinate conversion, pointer capture, active-stroke rendering,
// and the final stroke store through CanvasToolContext.
export const drawTool: CanvasToolExtension = {
  id: "draw",
  onPointerDown: (at, event, ctx) => {
    const started = startCanvasDrawingStroke(event, at, {
      color: ctx.penColor(),
      mode: activeDrawStrokeMode.value,
      worldToScreenScale: ctx.viewportScale(),
    });
    if (!started) return;

    let pendingSamples: CanvasPointerGestureSample[] = [];
    let frameId: number | null = null;
    const flushPendingSamples = (render: boolean) => {
      frameId = null;
      if (pendingSamples.length === 0) return;
      const samples = pendingSamples;
      pendingSamples = [];
      const stroke = addCanvasDrawingPoints(started.session, samples);
      if (render && stroke) ctx.setActiveStroke(stroke);
    };
    const cancelPendingFrame = () => {
      if (frameId === null) return;
      cancelAnimationFrame(frameId);
      frameId = null;
    };

    ctx.beginPointerGesture(event, {
      onMove: ({ samples }) => {
        pendingSamples.push(...samples);
        if (frameId === null) {
          frameId = requestAnimationFrame(() => flushPendingSamples(true));
        }
      },
      onEnd: () => {
        cancelPendingFrame();
        flushPendingSamples(false);
        const stroke = finishCanvasDrawingStroke(started.session);
        ctx.setActiveStroke(null);
        if (stroke) ctx.insertStroke(stroke);
      },
      onCancel: () => {
        cancelPendingFrame();
        pendingSamples = [];
        ctx.setActiveStroke(null);
      },
    });
    ctx.clearSelection();
    ctx.setActiveStroke(started.stroke);
  },
};

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
  const r = Math.max(0, 8 * transform.scale + expand);
  context.save();
  context.translate(sx, sy);
  context.rotate(((bounds.rotation ?? 0) * Math.PI) / 180);
  context.strokeStyle = strokeStyle;
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(-sw / 2, -sh / 2, sw, sh, r);
  context.stroke();
  context.restore();
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
    const bounds = pointBoundsForStroke(stroke);
    const padding = Math.max(stroke.style.width, FREEHAND_PEN_VELOCITY.maxWidth);
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

// Retained for callers that render static strokes and live ink into one canvas.
export function renderCanvasInk(params: CanvasInkRenderParams) {
  const {
    context,
    dpr,
    screen,
    transform,
    strokes,
    activeStroke,
    snapGuides,
    defaultInkColor,
  } = params;

  clearInkCanvas(context, dpr, screen);
  paintCanvasStrokes(context, strokes, transform, screen, defaultInkColor);
  drawCanvasInkOverlay(
    context,
    activeStroke,
    snapGuides,
    transform,
    screen,
    defaultInkColor,
  );
}

export function renderCanvasStrokes(
  params: Pick<
    CanvasInkRenderParams,
    "context" | "dpr" | "screen" | "transform" | "strokes" | "defaultInkColor"
  >,
) {
  const { context, dpr, screen, transform, strokes, defaultInkColor } = params;
  clearInkCanvas(context, dpr, screen);
  paintCanvasStrokes(context, strokes, transform, screen, defaultInkColor);
}

// Draw completed strokes into a caller-owned canvas without clearing it.
// Use this when ink shares a backing store with other canvas layers.
export function drawCanvasStrokes(
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

export type CanvasStrokeTransform = {
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

export type CanvasInkRendererOptions = {
  getDpr: () => number;
  getScreen: () => ScreenSize;
  getTransform: () => WorldTransform;
  getStrokes: () => CanvasStroke[];
  getDefaultInkColor: () => string;
  invalidateScene: () => void;
};

type StrokeBounds = { x: number; y: number; width: number; height: number };

function boundsForStroke(stroke: CanvasStroke): StrokeBounds | null {
  const bounds = pointBoundsForStroke(stroke);
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

export class CanvasInkRenderer {
  readonly #options: CanvasInkRendererOptions;
  #cache: StaticInkRasterCache | null = null;
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
      return;
    }

    const currentTransform = this.#options.getTransform();
    const color = this.#options.getDefaultInkColor();
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

    const { ratio, x, y } = this.#cachePlacement(cache, currentTransform);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      cache.canvas,
      x,
      y,
      cache.screen.width * ratio,
      cache.screen.height * ratio,
    );

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
      const previousCanvas = this.#cache?.canvas ?? null;
      this.#cache = build.cache;
      this.#spareCanvas = previousCanvas;
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
        Math.max(maxWidthForStroke(stroke), FREEHAND_PEN_VELOCITY.maxWidth) / 2 +
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
        Math.max(maxWidthForStroke(stroke), FREEHAND_PEN_VELOCITY.maxWidth) / 2 +
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

export type CanvasSelectionSnapshot = {
  strokes: CanvasStroke[];
  selectedStrokeIds: Set<string>;
  remoteSelectedStrokeIds?: Array<{ ids: Set<string>; color: string }>;
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

export type CanvasSelectionRenderParams = CanvasSelectionSnapshot & {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
};

export function renderCanvasSelections(params: CanvasSelectionRenderParams) {
  const {
    context,
    dpr,
    screen,
    transform,
    strokes,
    selectedStrokeIds,
    remoteSelectedStrokeIds = [],
    selectedShapeBounds = [],
    remoteSelectedShapeBounds = [],
  } = params;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.width, screen.height);
  context.setLineDash([]);
  drawRetainedFreehandSelection(
    context,
    retainCanvasSelectionStrokes(
      { strokes, selectedStrokeIds, remoteSelectedStrokeIds },
      transform,
    ),
    transform,
  );

  for (const bounds of selectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, "#2563eb");
  }

  for (const bounds of remoteSelectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, bounds.color);
  }
}

const SELECTION_MASK_MARGIN = 256;

const SELECTION_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const SELECTION_SEED_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
in vec2 v_uv;
out vec4 out_seed;
void main() {
  float alpha = texture(u_mask, v_uv).a;
  out_seed = alpha > 0.02 ? vec4(v_uv, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 1.0);
}`;

const SELECTION_JUMP_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_previous;
uniform vec2 u_size;
uniform float u_jump;
in vec2 v_uv;
out vec4 out_seed;
void main() {
  vec2 best = vec2(-1.0);
  float best_distance = 1.0e30;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 candidate_uv = v_uv + vec2(float(x), float(y)) * u_jump / u_size;
      if (any(lessThan(candidate_uv, vec2(0.0))) || any(greaterThan(candidate_uv, vec2(1.0)))) continue;
      vec2 seed = texture(u_previous, candidate_uv).xy;
      if (seed.x < 0.0) continue;
      float distance_to_seed = dot((seed - v_uv) * u_size, (seed - v_uv) * u_size);
      if (distance_to_seed < best_distance) {
        best_distance = distance_to_seed;
        best = seed;
      }
    }
  }
  out_seed = vec4(best, 0.0, 1.0);
}`;

const SELECTION_DISPLAY_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform sampler2D u_seeds;
uniform vec2 u_output_size;
uniform vec2 u_source_size;
uniform vec2 u_cache_screen;
uniform vec2 u_placement;
uniform float u_ratio;
uniform float u_output_dpr;
uniform float u_source_dpr;
in vec2 v_uv;
out vec4 out_color;
void main() {
  vec2 screen = vec2(
    gl_FragCoord.x / u_output_dpr,
    (u_output_size.y - gl_FragCoord.y) / u_output_dpr
  );
  vec2 source = (screen - u_placement) / u_ratio;
  vec2 source_uv = source / u_cache_screen;
  if (any(lessThan(source_uv, vec2(0.0))) || any(greaterThan(source_uv, vec2(1.0)))) discard;

  vec4 here = texture(u_mask, source_uv);
  if (here.a > 0.02) discard;
  vec2 seed = texture(u_seeds, source_uv).xy;
  if (seed.x < 0.0) discard;

  vec4 selected = texture(u_mask, seed);
  float expand = max(2.0, selected.a * 4.0);
  float distance_in_source_pixels = length((seed - source_uv) * u_source_size);
  float distance_on_screen = distance_in_source_pixels * u_ratio / u_source_dpr;
  float half_width = 0.5;
  float antialias = max(fwidth(distance_on_screen), 0.35);
  float inner = expand - half_width;
  float outer = expand + half_width;
  float ring = smoothstep(inner - antialias, inner, distance_on_screen)
    * (1.0 - smoothstep(outer, outer + antialias, distance_on_screen));
  if (ring <= 0.0) discard;
  out_color = vec4(selected.rgb, ring);
}`;

type SelectionProgram = {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
};

type SelectionGpuResources = {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  framebuffer: WebGLFramebuffer;
  vao: WebGLVertexArrayObject;
  maskTexture: WebGLTexture;
  seedTextures: [WebGLTexture, WebGLTexture];
  seedTextureIndex: 0 | 1;
  seed: SelectionProgram;
  jump: SelectionProgram;
  display: SelectionProgram;
  sourceWidth: number;
  sourceHeight: number;
  displayFilteringReady: boolean;
};

type SelectionMaskCache = {
  canvas: HTMLCanvasElement;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  selection: CanvasSelectionSnapshot;
};

function compileSelectionProgram(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
): SelectionProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Could not create selection shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) ?? "Unknown selection shader error";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, SELECTION_VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create selection shader program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message =
      gl.getProgramInfoLog(program) ?? "Unknown selection shader link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return { program, uniforms: new Map() };
}

function selectionUniform(
  gl: WebGL2RenderingContext,
  program: SelectionProgram,
  name: string,
) {
  const cached = program.uniforms.get(name);
  if (cached) return cached;
  const location = gl.getUniformLocation(program.program, name);
  if (!location) throw new Error(`Missing selection shader uniform: ${name}`);
  program.uniforms.set(name, location);
  return location;
}

function createSelectionGpuResources(): SelectionGpuResources | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    stencil: false,
  });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
  const framebuffer = gl.createFramebuffer();
  const vao = gl.createVertexArray();
  const maskTexture = gl.createTexture();
  const firstSeed = gl.createTexture();
  const secondSeed = gl.createTexture();
  if (!framebuffer || !vao || !maskTexture || !firstSeed || !secondSeed) return null;
  gl.bindVertexArray(vao);
  return {
    canvas,
    gl,
    framebuffer,
    vao,
    maskTexture,
    seedTextures: [firstSeed, secondSeed],
    seedTextureIndex: 0,
    seed: compileSelectionProgram(gl, SELECTION_SEED_SHADER),
    jump: compileSelectionProgram(gl, SELECTION_JUMP_SHADER),
    display: compileSelectionProgram(gl, SELECTION_DISPLAY_SHADER),
    sourceWidth: 0,
    sourceHeight: 0,
    displayFilteringReady: false,
  };
}

type RetainedCanvasSelection = {
  selection: CanvasSelectionSnapshot;
  scale: number;
  strokeGroups: RetainedFreehandSelectionGroup[];
};

export type CanvasSelectionRendererParams = {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
  selection: CanvasSelectionSnapshot;
  refresh?: boolean;
  deferRefresh?: boolean;
};

function hasCanvasSelection(selection: CanvasSelectionSnapshot) {
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

function paintSelectionMaskShape(
  context: CanvasRenderingContext2D,
  bounds: NonNullable<CanvasSelectionSnapshot["selectedShapeBounds"]>[number],
  transform: WorldTransform,
  color: string,
  alpha: number,
) {
  const sx = (bounds.x + bounds.width / 2) * transform.scale + transform.dx;
  const sy = (bounds.y + bounds.height / 2) * transform.scale + transform.dy;
  const width = bounds.width * transform.scale;
  const height = bounds.height * transform.scale;
  context.save();
  context.translate(sx, sy);
  context.rotate(((bounds.rotation ?? 0) * Math.PI) / 180);
  context.fillStyle = color;
  context.globalAlpha = alpha;
  context.beginPath();
  context.roundRect(
    -width / 2,
    -height / 2,
    width,
    height,
    Math.max(0, 8 * transform.scale),
  );
  context.fill();
  context.restore();
}

function buildSelectionMask(
  previous: SelectionMaskCache | null,
  dpr: number,
  screen: ScreenSize,
  transform: WorldTransform,
  selection: CanvasSelectionSnapshot,
) {
  const canvas = previous?.canvas ?? document.createElement("canvas");
  const cacheScreen = {
    width: screen.width + SELECTION_MASK_MARGIN * 2,
    height: screen.height + SELECTION_MASK_MARGIN * 2,
  };
  const width = Math.ceil(cacheScreen.width * dpr);
  const height = Math.ceil(cacheScreen.height * dpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Selection mask requires a 2D canvas context");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, cacheScreen.width, cacheScreen.height);

  const maskTransform = {
    scale: transform.scale,
    dx: transform.dx + SELECTION_MASK_MARGIN,
    dy: transform.dy + SELECTION_MASK_MARGIN,
  };
  const strokesById = new Map(selection.strokes.map((stroke) => [stroke.id, stroke]));
  const paintStrokes = (ids: Set<string>, color: string) => {
    for (const id of ids) {
      const stroke = strokesById.get(id);
      if (!stroke) continue;
      drawFreehandStroke(
        context,
        {
          ...stroke,
          style: { ...stroke.style, color, opacity: 1 },
        },
        maskTransform,
      );
    }
  };
  paintStrokes(selection.selectedStrokeIds, "#2563eb");
  for (const remote of selection.remoteSelectedStrokeIds ?? []) {
    paintStrokes(remote.ids, remote.color);
  }
  for (const bounds of selection.selectedShapeBounds ?? []) {
    paintSelectionMaskShape(
      context,
      bounds,
      maskTransform,
      "#2563eb",
      bounds.type === "section" ? 1 : 0.5,
    );
  }
  for (const bounds of selection.remoteSelectedShapeBounds ?? []) {
    paintSelectionMaskShape(
      context,
      bounds,
      maskTransform,
      bounds.color,
      bounds.type === "section" ? 1 : 0.5,
    );
  }
  return {
    canvas,
    dpr,
    screen: cacheScreen,
    transform: { ...transform },
    selection,
  } satisfies SelectionMaskCache;
}

function configureSelectionTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  filter = gl.NEAREST,
) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function updateSelectionDistanceField(
  resources: SelectionGpuResources,
  cache: SelectionMaskCache,
) {
  const { gl } = resources;
  const width = cache.canvas.width;
  const height = cache.canvas.height;
  resources.sourceWidth = width;
  resources.sourceHeight = height;
  resources.displayFilteringReady = false;

  configureSelectionTexture(gl, resources.maskTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cache.canvas);
  for (const texture of resources.seedTextures) {
    configureSelectionTexture(gl, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, null);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.BLEND);
  gl.useProgram(resources.seed.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, resources.maskTexture);
  gl.uniform1i(selectionUniform(gl, resources.seed, "u_mask"), 0);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    resources.seedTextures[0],
    0,
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  let sourceIndex: 0 | 1 = 0;
  let targetIndex: 0 | 1 = 1;
  gl.useProgram(resources.jump.program);
  gl.uniform1i(selectionUniform(gl, resources.jump, "u_previous"), 0);
  gl.uniform2f(selectionUniform(gl, resources.jump, "u_size"), width, height);
  let jump = 2 ** Math.floor(Math.log2(Math.max(width, height)));
  while (jump >= 1) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.seedTextures[sourceIndex]);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      resources.seedTextures[targetIndex],
      0,
    );
    gl.uniform1f(selectionUniform(gl, resources.jump, "u_jump"), jump);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    sourceIndex = targetIndex;
    targetIndex = sourceIndex === 0 ? 1 : 0;
    jump /= 2;
  }
  resources.seedTextureIndex = sourceIndex;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function renderGpuSelection(
  resources: SelectionGpuResources,
  cache: SelectionMaskCache,
  dpr: number,
  screen: ScreenSize,
  transform: WorldTransform,
) {
  const { canvas, gl, display } = resources;
  const outputDpr = Math.max(2, dpr);
  const width = Math.ceil(screen.width * outputDpr);
  const height = Math.ceil(screen.height * outputDpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ratio = transform.scale / cache.transform.scale;
  const x = (-SELECTION_MASK_MARGIN - cache.transform.dx) * ratio + transform.dx;
  const y = (-SELECTION_MASK_MARGIN - cache.transform.dy) * ratio + transform.dy;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(resources.vao);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(display.program);
  if (!resources.displayFilteringReady) {
    configureSelectionTexture(gl, resources.maskTexture, gl.LINEAR);
    resources.displayFilteringReady = true;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, resources.maskTexture);
  gl.uniform1i(selectionUniform(gl, display, "u_mask"), 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, resources.seedTextures[resources.seedTextureIndex]);
  gl.uniform1i(selectionUniform(gl, display, "u_seeds"), 1);
  gl.uniform2f(selectionUniform(gl, display, "u_output_size"), width, height);
  gl.uniform2f(
    selectionUniform(gl, display, "u_source_size"),
    resources.sourceWidth,
    resources.sourceHeight,
  );
  gl.uniform2f(
    selectionUniform(gl, display, "u_cache_screen"),
    cache.screen.width,
    cache.screen.height,
  );
  gl.uniform2f(selectionUniform(gl, display, "u_placement"), x, y);
  gl.uniform1f(selectionUniform(gl, display, "u_ratio"), ratio);
  gl.uniform1f(selectionUniform(gl, display, "u_output_dpr"), outputDpr);
  gl.uniform1f(selectionUniform(gl, display, "u_source_dpr"), cache.dpr);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function selectionMaskCovers(
  cache: SelectionMaskCache,
  screen: ScreenSize,
  transform: WorldTransform,
) {
  const ratio = transform.scale / cache.transform.scale;
  if (ratio < 2 / 3 || ratio > 3 / 2) return false;
  const x = (-SELECTION_MASK_MARGIN - cache.transform.dx) * ratio + transform.dx;
  const y = (-SELECTION_MASK_MARGIN - cache.transform.dy) * ratio + transform.dy;
  return (
    x <= 0 &&
    y <= 0 &&
    x + cache.screen.width * ratio >= screen.width &&
    y + cache.screen.height * ratio >= screen.height
  );
}

export class CanvasSelectionRenderer {
  #retained: RetainedCanvasSelection | null = null;
  #mask: SelectionMaskCache | null = null;
  #gpu: SelectionGpuResources | null | undefined;

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
      this.#retained = null;
      this.#releaseMask();
      this.#clear(context, dpr, screen);
      return;
    }

    if (this.#gpu === undefined) this.#gpu = createSelectionGpuResources();
    if (this.#gpu) {
      const mask = this.#mask;
      if (deferRefresh && (!mask || mask.selection !== selection)) {
        if (!mask) {
          this.#clear(context, dpr, screen);
          return;
        }
        renderGpuSelection(this.#gpu, mask, dpr, screen, transform);
        this.#copyGpuSurface(context, dpr, screen);
        return;
      }
      const surfaceChanged =
        !mask ||
        mask.dpr !== dpr ||
        mask.screen.width !== screen.width + SELECTION_MASK_MARGIN * 2 ||
        mask.screen.height !== screen.height + SELECTION_MASK_MARGIN * 2;
      const cameraOutgrewMask =
        Boolean(mask) && refresh && !selectionMaskCovers(mask, screen, transform);
      if (surfaceChanged || !mask || mask.selection !== selection || cameraOutgrewMask) {
        this.#mask = buildSelectionMask(this.#mask, dpr, screen, transform, selection);
        updateSelectionDistanceField(this.#gpu, this.#mask);
      }
      const activeMask = this.#mask;
      if (!activeMask) return;
      renderGpuSelection(this.#gpu, activeMask, dpr, screen, transform);
      this.#copyGpuSurface(context, dpr, screen);
      return;
    }

    if (deferRefresh && this.#retained?.selection !== selection) {
      if (this.#retained) this.#draw(context, dpr, screen, transform);
      else this.#clear(context, dpr, screen);
      return;
    }

    const retained = this.#retained;
    if (
      !retained ||
      retained.selection !== selection ||
      (refresh && retained.scale !== transform.scale)
    ) {
      this.#retained = {
        selection,
        scale: transform.scale,
        strokeGroups: retainCanvasSelectionStrokes(selection, transform),
      };
    }
    this.#draw(context, dpr, screen, transform);
  }

  #copyGpuSurface(context: CanvasRenderingContext2D, dpr: number, screen: ScreenSize) {
    const resources = this.#gpu;
    if (!resources) return;
    // drawImage crosses from this WebGL surface into the visible 2D layer.
    // Waiting here prevents Chromium from copying the just-cleared buffer
    // before the fullscreen selection pass has completed.
    resources.gl.finish();
    this.#clear(context, dpr, screen);
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.drawImage(resources.canvas, 0, 0, screen.width, screen.height);
    context.restore();
  }

  dispose() {
    this.#retained = null;
    this.#releaseMask();
    const resources = this.#gpu;
    if (resources) {
      const { gl } = resources;
      gl.deleteProgram(resources.seed.program);
      gl.deleteProgram(resources.jump.program);
      gl.deleteProgram(resources.display.program);
      gl.deleteTexture(resources.maskTexture);
      for (const texture of resources.seedTextures) gl.deleteTexture(texture);
      gl.deleteFramebuffer(resources.framebuffer);
      gl.deleteVertexArray(resources.vao);
      resources.canvas.width = 0;
      resources.canvas.height = 0;
    }
    this.#gpu = undefined;
  }

  #draw(
    context: CanvasRenderingContext2D,
    dpr: number,
    screen: ScreenSize,
    transform: WorldTransform,
  ) {
    const retained = this.#retained;
    if (!retained) {
      this.#clear(context, dpr, screen);
      return;
    }

    this.#clear(context, dpr, screen);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.setLineDash([]);
    drawRetainedFreehandSelection(context, retained.strokeGroups, transform);

    for (const bounds of retained.selection.selectedShapeBounds ?? []) {
      drawShapeOutline(context, bounds, transform, "#2563eb");
    }
    for (const bounds of retained.selection.remoteSelectedShapeBounds ?? []) {
      drawShapeOutline(context, bounds, transform, bounds.color);
    }
  }

  #clear(context: CanvasRenderingContext2D, dpr: number, screen: ScreenSize) {
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, screen.width, screen.height);
    context.restore();
  }

  #releaseMask() {
    if (!this.#mask) return;
    this.#mask.canvas.width = 0;
    this.#mask.canvas.height = 0;
    this.#mask = null;
    const resources = this.#gpu;
    if (!resources) return;
    const { gl } = resources;
    configureSelectionTexture(gl, resources.maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const texture of resources.seedTextures) {
      configureSelectionTexture(gl, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 1, 1, 0, gl.RG, gl.FLOAT, null);
    }
    resources.sourceWidth = 0;
    resources.sourceHeight = 0;
  }
}

export function createCanvasSelectionRenderer() {
  return new CanvasSelectionRenderer();
}
