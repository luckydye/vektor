import type { ScreenSize, WorldTransform } from "./transform";
import { screenToWorld, worldToScreen } from "./transform";

export interface WorldGridLevel {
  // Distance between grid lines in world units. Use 1 for a pixel grid when
  // world units map to image pixels.
  size: number;
  color?: string;
  lineWidth?: number;
  // Hide this level while its cell spacing is too dense on screen.
  minScreenSpacing?: number;
  // Hide this level while its cell spacing is too wide on screen.
  maxScreenSpacing?: number;
}

export interface DrawWorldGridOptions {
  levels?: WorldGridLevel[];
  size?: number;
  color?: string;
  lineWidth?: number;
  minScreenSpacing?: number;
  maxScreenSpacing?: number;
}

const DEFAULT_GRID_SIZE = 40;
const DEFAULT_GRID_COLOR = "rgba(255,255,255,0.08)";
const DEFAULT_GRID_LINE_WIDTH = 1;

function visibleWorldBounds(screen: ScreenSize, t: WorldTransform) {
  const topLeft = screenToWorld(0, 0, t);
  const bottomRight = screenToWorld(screen.width, screen.height, t);
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxX: Math.max(topLeft.x, bottomRight.x),
    maxY: Math.max(topLeft.y, bottomRight.y),
  };
}

function snapScreenLine(value: number, lineWidth: number) {
  return Math.round(value) + (lineWidth % 2 === 1 ? 0.5 : 0);
}

export function drawWorldGrid(
  ctx: CanvasRenderingContext2D,
  transform: WorldTransform,
  screen: ScreenSize,
  options: DrawWorldGridOptions = {},
): void {
  const levels = options.levels ?? [
    {
      size: options.size ?? DEFAULT_GRID_SIZE,
      color: options.color ?? DEFAULT_GRID_COLOR,
      lineWidth: options.lineWidth ?? DEFAULT_GRID_LINE_WIDTH,
      minScreenSpacing: options.minScreenSpacing,
      maxScreenSpacing: options.maxScreenSpacing,
    },
  ];
  const bounds = visibleWorldBounds(screen, transform);

  ctx.save();
  for (const level of levels) {
    if (level.size <= 0) continue;

    const screenSpacing = level.size * transform.scale;
    if (level.minScreenSpacing !== undefined && screenSpacing < level.minScreenSpacing) {
      continue;
    }
    if (level.maxScreenSpacing !== undefined && screenSpacing > level.maxScreenSpacing) {
      continue;
    }

    const lineWidth = level.lineWidth ?? DEFAULT_GRID_LINE_WIDTH;
    const startX = Math.floor(bounds.minX / level.size) * level.size;
    const startY = Math.floor(bounds.minY / level.size) * level.size;
    const endX = Math.ceil(bounds.maxX / level.size) * level.size;
    const endY = Math.ceil(bounds.maxY / level.size) * level.size;

    ctx.beginPath();
    for (let x = startX; x <= endX; x += level.size) {
      const sx = snapScreenLine(worldToScreen(x, 0, transform).x, lineWidth);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, screen.height);
    }
    for (let y = startY; y <= endY; y += level.size) {
      const sy = snapScreenLine(worldToScreen(0, y, transform).y, lineWidth);
      ctx.moveTo(0, sy);
      ctx.lineTo(screen.width, sy);
    }

    ctx.strokeStyle = level.color ?? DEFAULT_GRID_COLOR;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}

export interface DrawWorldDotsOptions {
  // Distance between dots in world units.
  size?: number;
  color?: string;
  // Dot radius in screen pixels (kept constant regardless of zoom).
  radius?: number;
  // Hide the dots while their spacing is too dense on screen.
  minScreenSpacing?: number;
}

const DEFAULT_DOT_RADIUS = 1.2;
const DOT_PATTERN_TILE_SIZE = 64;
const DOT_PATTERN_CACHE_LIMIT = 64;
const dotPatternTiles = new Map<string, CanvasImageSource>();
// CanvasPattern objects are tied to a specific ctx — key includes a ctx id.
// We reuse the same grid canvas across frames so the ctx is stable.
const dotPatternCache = new Map<string, CanvasPattern>();
let dotPatternCtxId = 0;
const dotPatternCtxIds = new WeakMap<CanvasRenderingContext2D, number>();

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function roundedPatternSpacing(screenSpacing: number) {
  return Math.max(1, Math.round(screenSpacing * 4) / 4);
}

function getDotPatternTile(
  color: string,
  radius: number,
  screenSpacing: number,
): CanvasImageSource {
  const roundedSpacing = roundedPatternSpacing(screenSpacing);
  const sourceRadius = Math.max(0.5, (radius * DOT_PATTERN_TILE_SIZE) / roundedSpacing);
  const key = `${color}|${sourceRadius.toFixed(3)}`;
  const cached = dotPatternTiles.get(key);
  if (cached) return cached;

  const surface =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(DOT_PATTERN_TILE_SIZE, DOT_PATTERN_TILE_SIZE)
      : document.createElement("canvas");
  surface.width = DOT_PATTERN_TILE_SIZE;
  surface.height = DOT_PATTERN_TILE_SIZE;
  const surfaceCtx = surface.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!surfaceCtx) return surface;

  surfaceCtx.fillStyle = color;
  surfaceCtx.beginPath();
  for (const x of [0, DOT_PATTERN_TILE_SIZE]) {
    for (const y of [0, DOT_PATTERN_TILE_SIZE]) {
      surfaceCtx.moveTo(x + sourceRadius, y);
      surfaceCtx.arc(x, y, sourceRadius, 0, Math.PI * 2);
    }
  }
  surfaceCtx.fill();

  if (dotPatternTiles.size >= DOT_PATTERN_CACHE_LIMIT) {
    const oldestKey = dotPatternTiles.keys().next().value;
    if (oldestKey) dotPatternTiles.delete(oldestKey);
  }
  dotPatternTiles.set(key, surface);
  return surface;
}

function drawWorldDotsAsPaths(
  ctx: CanvasRenderingContext2D,
  transform: WorldTransform,
  screen: ScreenSize,
  size: number,
  color: string,
  radius: number,
): void {
  const bounds = visibleWorldBounds(screen, transform);
  const startX = Math.floor(bounds.minX / size) * size;
  const startY = Math.floor(bounds.minY / size) * size;
  const endX = Math.ceil(bounds.maxX / size) * size;
  const endY = Math.ceil(bounds.maxY / size) * size;

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += size) {
    const sx = worldToScreen(x, 0, transform).x;
    for (let y = startY; y <= endY; y += size) {
      const sy = worldToScreen(0, y, transform).y;
      ctx.moveTo(sx + radius, sy);
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
}

// Draws a dot at each grid intersection. Mirrors drawWorldGrid's world→screen
// placement so dots line up with where grid lines would cross.
export function drawWorldDots(
  ctx: CanvasRenderingContext2D,
  transform: WorldTransform,
  screen: ScreenSize,
  options: DrawWorldDotsOptions = {},
): void {
  const size = options.size ?? DEFAULT_GRID_SIZE;
  if (size <= 0) return;

  const screenSpacing = size * transform.scale;
  if (
    options.minScreenSpacing !== undefined &&
    screenSpacing < options.minScreenSpacing
  ) {
    return;
  }

  const radius = options.radius ?? DEFAULT_DOT_RADIUS;
  const color = options.color ?? DEFAULT_GRID_COLOR;
  const patternTile = getDotPatternTile(color, radius, screenSpacing);

  // Cache CanvasPattern per (ctx, tile) — createPattern is non-trivial.
  if (!dotPatternCtxIds.has(ctx)) dotPatternCtxIds.set(ctx, ++dotPatternCtxId);
  const ctxId = dotPatternCtxIds.get(ctx)!;
  const roundedSpacing = roundedPatternSpacing(screenSpacing);
  const sourceRadius = Math.max(0.5, (radius * DOT_PATTERN_TILE_SIZE) / roundedSpacing);
  const patternKey = `${ctxId}|${color}|${sourceRadius.toFixed(3)}`;
  let pattern = dotPatternCache.get(patternKey);
  if (!pattern) {
    const created = ctx.createPattern(patternTile, "repeat");
    if (!created) {
      drawWorldDotsAsPaths(ctx, transform, screen, size, color, radius);
      return;
    }
    pattern = created;
    if (dotPatternCache.size >= DOT_PATTERN_CACHE_LIMIT) {
      const oldestKey = dotPatternCache.keys().next().value;
      if (oldestKey) dotPatternCache.delete(oldestKey);
    }
    dotPatternCache.set(patternKey, pattern);
  }

  if (typeof pattern.setTransform !== "function" || typeof DOMMatrix !== "function") {
    drawWorldDotsAsPaths(ctx, transform, screen, size, color, radius);
    return;
  }

  const offsetX = positiveModulo(transform.dx, screenSpacing);
  const offsetY = positiveModulo(transform.dy, screenSpacing);
  pattern.setTransform(
    new DOMMatrix()
      .translateSelf(offsetX, offsetY)
      .scaleSelf(screenSpacing / DOT_PATTERN_TILE_SIZE),
  );

  ctx.save();
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, screen.width, screen.height);
  ctx.restore();
}
