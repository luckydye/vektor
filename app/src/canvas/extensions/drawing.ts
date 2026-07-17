import { ref } from "vue";
import * as Y from "yjs";
import { canvasPenIcon, pencilIcon } from "#assets/icons.ts";
import type { TranslationKey } from "#utils/lang.ts";
import {
  buildFreehandStroke,
  createFreehandStrokeBuilder,
  drawFreehandOutline,
  drawFreehandStroke,
  drawSnapGuides,
  fillFreehandStrokeMask,
  type FreehandPoint,
  type FreehandStroke,
  type FreehandStrokeBuilder,
  type FreehandStrokeOptions,
  type FreehandStrokeStyle,
  type ScreenSize,
  type SnapGuide,
  type WorldTransform,
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

export function renderCanvasSelections(params: {
  context: CanvasRenderingContext2D;
  dpr: number;
  screen: ScreenSize;
  transform: WorldTransform;
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
}) {
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

  if (selectedStrokeIds.size > 0) {
    context.save();
    context.strokeStyle = "#2563eb";
    context.lineWidth = 1.5;
    context.setLineDash([]);
    for (const id of selectedStrokeIds) {
      const stroke = strokes.find((s) => s.id === id);
      if (!stroke || stroke.points.length === 0) continue;
      drawFreehandOutline(context, stroke, transform, 4);
    }
    context.restore();
  }

  for (const selection of remoteSelectedStrokeIds) {
    if (selection.ids.size === 0) continue;
    context.save();
    context.strokeStyle = selection.color;
    context.lineWidth = 1.5;
    context.setLineDash([]);
    for (const id of selection.ids) {
      const stroke = strokes.find((s) => s.id === id);
      if (!stroke || stroke.points.length === 0) continue;
      drawFreehandOutline(context, stroke, transform, 4);
    }
    context.restore();
  }

  for (const bounds of selectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, "#2563eb");
  }

  for (const bounds of remoteSelectedShapeBounds) {
    drawShapeOutline(context, bounds, transform, bounds.color);
  }
}
