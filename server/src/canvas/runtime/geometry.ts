/**
 * Canvas maths: rects, rotation, world<->screen transforms, snapping. Pure — no
 * DOM, no canvas context.
 */

import { strokePointBounds } from "#canvas/render/freehand.ts";
import type { CanvasStroke } from "#canvas/runtime/extensionApi.ts";

// ---------------------------------------------------------------------------
// from geometry/rect.ts
// ---------------------------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };

/** Text shapes scale by font size rather than box size; these bound that. */
export const MIN_FONT_SCALE = 0.3;
const MAX_FONT_SCALE = 10;

export function clampFontScale(value: number): number {
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

/** A finite number, or the fallback. Guards values coming out of Yjs. */
export function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The axis-aligned box around a freehand stroke, or null if it has no points. */
export function strokeBounds(points: readonly CanvasPoint[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The union of several boxes, or null when there are none. */
export function unionBounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Handles keep a fixed size on screen, so their offset from the shape shrinks
 * as the viewport zooms in. These convert that screen-space gap back to world
 * units before projecting, which is why the scale has to be passed in.
 */
interface HandlePlacement {
  rotation: CanvasPoint;
  resize: CanvasPoint;
}

const ROTATION_GAP_PX = 24;
const RESIZE_GAP_PX = 18;

export function handleOffsets(scale: number): { rotation: number; resize: number } {
  return {
    rotation: ROTATION_GAP_PX / scale,
    resize: RESIZE_GAP_PX / scale / Math.SQRT2,
  };
}

/** Handle positions for an axis-aligned box — strokes and multi-selections. */
export function axisAlignedHandles(
  bounds: Rect,
  scale: number,
  worldToScreen: (point: CanvasPoint) => CanvasPoint,
): HandlePlacement {
  const offset = handleOffsets(scale);
  return {
    rotation: worldToScreen({
      x: bounds.x + bounds.width / 2,
      y: bounds.y - offset.rotation,
    }),
    resize: worldToScreen({
      x: bounds.x + bounds.width + offset.resize,
      y: bounds.y + bounds.height + offset.resize,
    }),
  };
}

/** The scale handle alone, for a multi-selection box that does not rotate. */
export function scaleHandle(
  bounds: Rect,
  scale: number,
  worldToScreen: (point: CanvasPoint) => CanvasPoint,
): CanvasPoint {
  const offset = handleOffsets(scale);
  return worldToScreen({
    x: bounds.x + bounds.width + offset.resize,
    y: bounds.y + bounds.height + offset.resize,
  });
}

/** Whether a point falls inside an axis-aligned box. */
export function isPointInRect(point: CanvasPoint, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

// ---------------------------------------------------------------------------
// from geometry/rotation.ts
// ---------------------------------------------------------------------------

export type CanvasPoint = { x: number; y: number };

export type CanvasRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
};

const DEGREES_TO_RADIANS = Math.PI / 180;

export function normalizeRotation(rotation: number | undefined): number {
  const value = Number.isFinite(rotation) ? Number(rotation) : 0;
  return ((value % 360) + 360) % 360;
}

function radians(rotation: number | undefined) {
  return normalizeRotation(rotation) * DEGREES_TO_RADIANS;
}

export function rotateVector(
  point: CanvasPoint,
  rotation: number | undefined,
): CanvasPoint {
  const angle = radians(rotation);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function shapeCenter(shape: CanvasRect): CanvasPoint {
  return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
}

export function rotatedShapeCorners(shape: CanvasRect): CanvasPoint[] {
  const center = shapeCenter(shape);
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((corner) => {
    const rotated = rotateVector(corner, shape.rotation);
    return { x: center.x + rotated.x, y: center.y + rotated.y };
  });
}

export function rotatedShapeBounds(shape: CanvasRect): CanvasRect {
  const corners = rotatedShapeCorners(shape);
  const minX = Math.min(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));
  const maxX = Math.max(...corners.map((corner) => corner.x));
  const maxY = Math.max(...corners.map((corner) => corner.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pointInRotatedShape(point: CanvasPoint, shape: CanvasRect): boolean {
  const center = shapeCenter(shape);
  const local = rotateVector(
    { x: point.x - center.x, y: point.y - center.y },
    -normalizeRotation(shape.rotation),
  );
  return Math.abs(local.x) <= shape.width / 2 && Math.abs(local.y) <= shape.height / 2;
}

export function rotationFromPointer(center: CanvasPoint, point: CanvasPoint): number {
  return normalizeRotation(
    (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI + 90,
  );
}

export function snapRotation(rotation: number, increment = 15): number {
  return normalizeRotation(Math.round(rotation / increment) * increment);
}

export function pointOnRotatedShape(
  shape: CanvasRect,
  localPoint: CanvasPoint,
): CanvasPoint {
  const center = shapeCenter(shape);
  const localFromCenter = {
    x: localPoint.x - shape.width / 2,
    y: localPoint.y - shape.height / 2,
  };
  const rotated = rotateVector(localFromCenter, shape.rotation);
  return { x: center.x + rotated.x, y: center.y + rotated.y };
}

export function resizeRotatedShapeFromBottomRight(params: {
  fixedTopLeft: CanvasPoint;
  pointer: CanvasPoint;
  rotation: number;
  minSize: { width: number; height: number };
  aspect?: number;
}): Pick<CanvasRect, "x" | "y" | "width" | "height"> {
  const pointerInLocalSpace = rotateVector(
    {
      x: params.pointer.x - params.fixedTopLeft.x,
      y: params.pointer.y - params.fixedTopLeft.y,
    },
    -params.rotation,
  );

  let width = pointerInLocalSpace.x;
  let height = pointerInLocalSpace.y;
  if (params.aspect) {
    width = Math.max(width, height * params.aspect, params.minSize.width);
    height = width / params.aspect;
    if (height < params.minSize.height) {
      height = params.minSize.height;
      width = height * params.aspect;
    }
  } else {
    width = Math.max(params.minSize.width, width);
    height = Math.max(params.minSize.height, height);
  }

  const centerOffset = rotateVector({ x: width / 2, y: height / 2 }, params.rotation);
  const center = {
    x: params.fixedTopLeft.x + centerOffset.x,
    y: params.fixedTopLeft.y + centerOffset.y,
  };
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// from geometry/transform.ts
// ---------------------------------------------------------------------------

export interface ScreenSize {
  width: number;
  height: number;
}

// Camera: defines what portion of world space is visible in the viewport.
export interface ViewportCamera {
  // World-space point shown at the center of the screen
  centerX: number;
  centerY: number;
  // Zoom multiplier: 1.0 = the fit reference fills the screen
  zoom: number;
}

// The rect that defines what "zoom = 1" means. The canvas is infinite, so this
// is a fixed reference frame rather than a document boundary — it only fixes the
// meaning of zoom and the pan clamp, and never limits where shapes may live.
export interface FitReference {
  x: number;
  y: number;
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

// ---------------------------------------------------------------------------
// from geometry/snapping.ts
// ---------------------------------------------------------------------------

type SnapGuideAxis = "x" | "y";
type SnapGuideKind = "edge" | "center" | "custom";
/** "target" = another shape's bounds; "custom" = a guide a caller injected. */
type SnapGuideSource = "target" | "custom";

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapGuide {
  axis: SnapGuideAxis;
  value: number;
  kind: SnapGuideKind;
  source: SnapGuideSource;
  sourceId: string;
  label?: string;
  priority?: number;
}

interface SnapTarget {
  id: string;
  bounds: WorldRect;
  include?: Array<"edges" | "center">;
}

interface SnapGuideQuery {
  camera: ViewportCamera;
  screen: ScreenSize;
  fit: FitReference;
  targets?: SnapTarget[];
  radiusPx?: number;
}

interface SnapRectOptions {
  guides: readonly SnapGuide[];
  bounds: WorldRect;
  threshold: number;
}

interface SnapRectResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

interface SnapCandidate {
  delta: number;
  guide: SnapGuide;
  distance: number;
}

const SNAP_GUIDE_DISTANCE_EPSILON = 1e-6;

function pushRectGuides(
  guides: SnapGuide[],
  rect: WorldRect,
  source: SnapGuideSource,
  sourceId: string,
  include: Array<"edges" | "center"> = ["edges", "center"],
) {
  if (include.includes("edges")) {
    guides.push(
      { axis: "x", value: rect.x, kind: "edge", source, sourceId, label: "left" },
      {
        axis: "x",
        value: rect.x + rect.width,
        kind: "edge",
        source,
        sourceId,
        label: "right",
      },
      { axis: "y", value: rect.y, kind: "edge", source, sourceId, label: "top" },
      {
        axis: "y",
        value: rect.y + rect.height,
        kind: "edge",
        source,
        sourceId,
        label: "bottom",
      },
    );
  }

  if (include.includes("center")) {
    guides.push(
      {
        axis: "x",
        value: rect.x + rect.width / 2,
        kind: "center",
        source,
        sourceId,
        label: "center-x",
        priority: 1,
      },
      {
        axis: "y",
        value: rect.y + rect.height / 2,
        kind: "center",
        source,
        sourceId,
        label: "center-y",
        priority: 1,
      },
    );
  }
}

export function worldViewportBounds(
  camera: ViewportCamera,
  screen: ScreenSize,
  fit: FitReference,
  radiusPx = 0,
): WorldRect {
  const transform = buildTransform(camera, screen, fit);
  const topLeft = screenToWorld(0, 0, transform);
  const bottomRight = screenToWorld(screen.width, screen.height, transform);
  const padding = radiusPx / transform.scale;

  return {
    x: topLeft.x - padding,
    y: topLeft.y - padding,
    width: bottomRight.x - topLeft.x + padding * 2,
    height: bottomRight.y - topLeft.y + padding * 2,
  };
}

function computeSnapGuides(query: SnapGuideQuery): SnapGuide[] {
  const radiusPx = query.radiusPx ?? 96;
  const bounds = worldViewportBounds(query.camera, query.screen, query.fit, radiusPx);
  const minX = bounds.x;
  const maxX = bounds.x + bounds.width;
  const minY = bounds.y;
  const maxY = bounds.y + bounds.height;
  const candidates: SnapGuide[] = [];

  for (const target of query.targets ?? []) {
    pushRectGuides(candidates, target.bounds, "target", target.id, target.include);
  }

  return candidates.filter((guide) =>
    guide.axis === "x"
      ? guide.value >= minX && guide.value <= maxX
      : guide.value >= minY && guide.value <= maxY,
  );
}

function snapCandidateKey(candidate: SnapCandidate): string {
  return `${candidate.guide.source}:${candidate.guide.sourceId}:${
    candidate.guide.kind
  }:${candidate.guide.label ?? ""}`;
}

function isBetterSnapCandidate(
  candidate: SnapCandidate,
  current: SnapCandidate | null,
): boolean {
  if (!current) return true;
  if (candidate.distance < current.distance - SNAP_GUIDE_DISTANCE_EPSILON) {
    return true;
  }
  if (candidate.distance > current.distance + SNAP_GUIDE_DISTANCE_EPSILON) {
    return false;
  }

  const candidatePriority = candidate.guide.priority ?? 0;
  const currentPriority = current.guide.priority ?? 0;
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority;
  }

  if (
    Math.abs(candidate.guide.value - current.guide.value) > SNAP_GUIDE_DISTANCE_EPSILON
  ) {
    return candidate.guide.value < current.guide.value;
  }

  return snapCandidateKey(candidate) < snapCandidateKey(current);
}

function snapRectToGuides(options: SnapRectOptions): SnapRectResult {
  const { bounds, guides, threshold } = options;
  const movingX = [bounds.x, bounds.x + bounds.width * 0.5, bounds.x + bounds.width];
  const movingY = [bounds.y, bounds.y + bounds.height * 0.5, bounds.y + bounds.height];
  let bestX: SnapCandidate | null = null;
  let bestY: SnapCandidate | null = null;

  for (const guide of guides) {
    const values = guide.axis === "x" ? movingX : movingY;
    for (const value of values) {
      const delta = guide.value - value;
      const distance = Math.abs(delta);
      if (distance > threshold) continue;
      const candidate = { delta, guide, distance };
      if (guide.axis === "x" && isBetterSnapCandidate(candidate, bestX)) {
        bestX = candidate;
      } else if (guide.axis === "y" && isBetterSnapCandidate(candidate, bestY)) {
        bestY = candidate;
      }
    }
  }

  return {
    dx: bestX?.delta ?? 0,
    dy: bestY?.delta ?? 0,
    guides: [bestX?.guide, bestY?.guide].filter((guide): guide is SnapGuide =>
      Boolean(guide),
    ),
  };
}

interface DragSnapOptions {
  /** Where the moving group started, before the drag offset is applied. */
  bounds: WorldRect | null;
  dx: number;
  dy: number;
  /** Snapping is bypassed while the modifier is held. */
  disabled: boolean;
  scale: number;
  camera: ViewportCamera;
  screen: ScreenSize;
  fit: FitReference;
  /** Every element the drag is *not* moving — filtered by proximity here. */
  candidates: readonly SnapTarget[];
}

/** How near a candidate must be to take part, and how near a guide must be to catch. */
const SNAP_PROXIMITY_PX = 320;
const SNAP_THRESHOLD_PX = 6;

/**
 * Nudges a drag offset so the moving group's edges and centers line up with the
 * elements it is not moving.
 *
 * Both distances are screen-space constants divided by the scale: a snap must
 * feel the same at every zoom level, and a world-space threshold would not.
 *
 * Candidates are pre-filtered to a proximity window around the group. A canvas
 * can hold hundreds of elements and this runs on every pointermove, so building
 * guides for all of them is the difference between a smooth drag and a stuttery
 * one — the cheap rect test pays for itself.
 */
export function snapDragOffset(options: DragSnapOptions): SnapRectResult {
  const { bounds, dx, dy, scale } = options;
  if (options.disabled || !bounds) return { dx, dy, guides: [] };

  const margin = SNAP_PROXIMITY_PX / scale;
  const near: WorldRect = {
    x: bounds.x + dx - margin,
    y: bounds.y + dy - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  };

  const guides = computeSnapGuides({
    camera: options.camera,
    screen: options.screen,
    fit: options.fit,
    targets: options.candidates.filter((target) => rectsOverlap(near, target.bounds)),
  });

  const snap = snapRectToGuides({
    guides,
    bounds: { ...bounds, x: bounds.x + dx, y: bounds.y + dy },
    threshold: SNAP_THRESHOLD_PX / scale,
  });

  return { dx: dx + snap.dx, dy: dy + snap.dy, guides: snap.guides };
}

function rectsOverlap(a: WorldRect, b: WorldRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// ---------------------------------------------------------------------------
// from runtime/strokeGeometry.ts
// ---------------------------------------------------------------------------

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

export function hitTestCanvasStroke(
  strokes: readonly CanvasStroke[],
  world: { x: number; y: number },
  worldToScreenScale: number,
): string | null {
  const scale = worldToScreenScale || 1;
  // Search topmost (last drawn) first.
  for (let i = strokes.length - 1; i >= 0; i -= 1) {
    const stroke = strokes[i];
    const points = stroke.points;
    const threshold = stroke.style.width / 2 + 8 / scale;
    const bounds = strokePointBounds(stroke);
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
