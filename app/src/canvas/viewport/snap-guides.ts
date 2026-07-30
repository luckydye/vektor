import type { ScreenSize, WorldTransform } from "./transform";
import { buildTransform, screenToWorld } from "./transform";
import type { Artboard, FitReference, ViewportCamera } from "./types";

export type SnapGuideAxis = "x" | "y";
export type SnapGuideKind = "edge" | "center" | "custom";
export type SnapGuideSource = "artboard" | "target";

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

export interface SnapTarget {
  id: string;
  bounds: WorldRect;
  include?: Array<"edges" | "center">;
}

export interface SnapGuideQuery {
  camera: ViewportCamera;
  screen: ScreenSize;
  fit: FitReference;
  artboards?: Artboard[];
  targets?: SnapTarget[];
  radiusPx?: number;
}

export interface DrawSnapGuideOptions {
  color?: string;
  lineWidth?: number;
  dash?: number[];
}

export interface SnapRectOptions {
  guides: readonly SnapGuide[];
  bounds: WorldRect;
  threshold: number;
}

export interface SnapRectResult {
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

export function computeSnapGuides(query: SnapGuideQuery): SnapGuide[] {
  const radiusPx = query.radiusPx ?? 96;
  const bounds = worldViewportBounds(query.camera, query.screen, query.fit, radiusPx);
  const minX = bounds.x;
  const maxX = bounds.x + bounds.width;
  const minY = bounds.y;
  const maxY = bounds.y + bounds.height;
  const candidates: SnapGuide[] = [];

  for (const artboard of query.artboards ?? []) {
    pushRectGuides(
      candidates,
      {
        x: artboard.worldX,
        y: artboard.worldY,
        width: artboard.width,
        height: artboard.height,
      },
      "artboard",
      `artboard:${artboard.worldX},${artboard.worldY}`,
    );
  }

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

export function snapRectToGuides(options: SnapRectOptions): SnapRectResult {
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

export function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  guides: readonly SnapGuide[],
  transform: WorldTransform,
  screen: ScreenSize,
  options: DrawSnapGuideOptions = {},
): void {
  if (guides.length === 0) return;

  ctx.save();
  ctx.strokeStyle = options.color ?? "rgba(96, 165, 250, 0.8)";
  ctx.lineWidth = options.lineWidth ?? 1;
  ctx.setLineDash(options.dash ?? [4, 4]);

  for (const guide of guides) {
    ctx.beginPath();
    if (guide.axis === "x") {
      const x = guide.value * transform.scale + transform.dx;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, screen.height);
    } else {
      const y = guide.value * transform.scale + transform.dy;
      ctx.moveTo(0, y);
      ctx.lineTo(screen.width, y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

export interface DragSnapOptions {
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
