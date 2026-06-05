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
