import type { FitReference, ViewportCamera } from "./types";

export interface ScreenSize {
  width: number;
  height: number;
}

// A 2D affine transform that maps world coordinates to screen coordinates.
export interface WorldTransform {
  // Screen pixels per world unit
  scale: number;
  // Screen X position of the world origin
  dx: number;
  // Screen Y position of the world origin
  dy: number;
}

// Compute the scale that makes the fit reference fill the screen at zoom = 1.
export function computeFitScale(screen: ScreenSize, fit: FitReference): number {
  if (screen.width <= 0 || screen.height <= 0 || fit.width <= 0 || fit.height <= 0)
    return 1;
  return Math.min(screen.width / fit.width, screen.height / fit.height);
}

// Build the world→screen transform from camera, screen size, and fit reference.
export function buildTransform(
  camera: ViewportCamera,
  screen: ScreenSize,
  fit: FitReference,
): WorldTransform {
  const fitScale = computeFitScale(screen, fit);
  const scale = fitScale * camera.zoom;
  return {
    scale,
    dx: screen.width * 0.5 - camera.centerX * scale,
    dy: screen.height * 0.5 - camera.centerY * scale,
  };
}

export function worldToScreen(wx: number, wy: number, t: WorldTransform) {
  return { x: wx * t.scale + t.dx, y: wy * t.scale + t.dy };
}

export function screenToWorld(sx: number, sy: number, t: WorldTransform) {
  return { x: (sx - t.dx) / t.scale, y: (sy - t.dy) / t.scale };
}

// Clamp camera center so panning doesn't scroll outside the fit reference bounds.
// When the image is smaller than the viewport in a dimension, center it.
export function clampCamera(
  zoom: number,
  centerX: number,
  centerY: number,
  screen: ScreenSize,
  fit: FitReference,
): ViewportCamera {
  const fitScale = computeFitScale(screen, fit);
  const imageScale = fitScale * zoom;
  const visW = screen.width / imageScale;
  const visH = screen.height / imageScale;
  const cx =
    visW >= fit.width
      ? fit.x + fit.width * 0.5
      : Math.max(fit.x + visW * 0.5, Math.min(centerX, fit.x + fit.width - visW * 0.5));
  const cy =
    visH >= fit.height
      ? fit.y + fit.height * 0.5
      : Math.max(fit.y + visH * 0.5, Math.min(centerY, fit.y + fit.height - visH * 0.5));
  return { centerX: cx, centerY: cy, zoom };
}
