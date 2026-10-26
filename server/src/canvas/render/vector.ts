/**
 * Vector path maths shared by the WebGL painter and the server rasterizer:
 * flattening bezier paths, and turning polylines into fillable polygons for
 * strokes, dashes and joins. Pure functions in world units.
 */

import type { CanvasPoint } from "#canvas/runtime/geometry.ts";

/** A path vertex; `in`/`out` are absolute bezier handles in the same space. */
export interface VectorNode {
  x: number;
  y: number;
  in?: CanvasPoint;
  out?: CanvasPoint;
}

export type StrokeJoin = "miter" | "round";
export type StrokeCap = "butt" | "round";

/** Rings to fill; "nonzero" for outlines, "union" for overlapping stroke pieces. */
export interface FillPath {
  rings: CanvasPoint[][];
  rule: "nonzero" | "union";
}

function flattenCubic(
  a: CanvasPoint,
  b: CanvasPoint,
  c: CanvasPoint,
  d: CanvasPoint,
  tolerance: number,
  out: CanvasPoint[],
) {
  // Segment count from the control polygon's deviation (Wang's formula).
  const ddx = Math.max(Math.abs(a.x - 2 * b.x + c.x), Math.abs(b.x - 2 * c.x + d.x));
  const ddy = Math.max(Math.abs(a.y - 2 * b.y + c.y), Math.abs(b.y - 2 * c.y + d.y));
  const steps = Math.min(
    256,
    Math.max(1, Math.ceil(Math.sqrt((0.75 * Math.hypot(ddx, ddy)) / tolerance))),
  );
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
      y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
    });
  }
}

/** The path as a polyline; a closed path does not repeat its first point. */
export function flattenPath(
  nodes: readonly VectorNode[],
  closed: boolean,
  tolerance: number,
): CanvasPoint[] {
  if (nodes.length === 0) return [];
  const points: CanvasPoint[] = [{ x: nodes[0].x, y: nodes[0].y }];
  const count = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < count; i++) {
    const from = nodes[i];
    const to = nodes[(i + 1) % nodes.length];
    if (from.out || to.in) {
      flattenCubic(from, from.out ?? from, to.in ?? to, to, tolerance, points);
    } else {
      points.push({ x: to.x, y: to.y });
    }
  }
  if (closed && points.length > 1) points.pop();
  return dedupe(points);
}

function dedupe(points: CanvasPoint[]): CanvasPoint[] {
  return points.filter(
    (point, index) =>
      index === 0 ||
      Math.abs(point.x - points[index - 1].x) > 1e-6 ||
      Math.abs(point.y - points[index - 1].y) > 1e-6,
  );
}

export function circlePolygon(
  center: CanvasPoint,
  radius: number,
  tolerance: number,
): CanvasPoint[] {
  const step = 2 * Math.acos(Math.max(-1, 1 - tolerance / Math.max(radius, tolerance)));
  const segments = Math.min(128, Math.max(8, Math.ceil((Math.PI * 2) / step)));
  return Array.from({ length: segments }, (_, i) => {
    const angle = (i / segments) * Math.PI * 2;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
}

/** Overlapping convex pieces covering the stroke; fill them as a union. */
export function strokePolygons(
  points: readonly CanvasPoint[],
  options: {
    closed: boolean;
    width: number;
    join: StrokeJoin;
    cap: StrokeCap;
    tolerance: number;
  },
): CanvasPoint[][] {
  const half = options.width / 2;
  const { closed } = options;
  const pieces: CanvasPoint[][] = [];
  if (points.length === 1) {
    if (options.cap === "round")
      pieces.push(circlePolygon(points[0], half, options.tolerance));
    return pieces;
  }
  const segmentCount = closed ? points.length : points.length - 1;
  const normal = (a: CanvasPoint, b: CanvasPoint) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (-(b.y - a.y) / length) * half, y: ((b.x - a.x) / length) * half };
  };
  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const n = normal(a, b);
    pieces.push([
      { x: a.x + n.x, y: a.y + n.y },
      { x: b.x + n.x, y: b.y + n.y },
      { x: b.x - n.x, y: b.y - n.y },
      { x: a.x - n.x, y: a.y - n.y },
    ]);
  }
  const first = closed ? 0 : 1;
  const last = closed ? points.length : points.length - 1;
  for (let i = first; i < last; i++) {
    const at = points[i];
    if (options.join === "round") {
      pieces.push(circlePolygon(at, half, options.tolerance));
      continue;
    }
    const before = points[(i - 1 + points.length) % points.length];
    const after = points[(i + 1) % points.length];
    const n1 = normal(before, at);
    const n2 = normal(at, after);
    // The outer side is where the path turns away from.
    const turn = (at.x - before.x) * (after.y - at.y) - (at.y - before.y) * (after.x - at.x);
    const side = turn > 0 ? -1 : 1;
    const p1 = { x: at.x + n1.x * side, y: at.y + n1.y * side };
    const p2 = { x: at.x + n2.x * side, y: at.y + n2.y * side };
    const bisector = { x: n1.x + n2.x, y: n1.y + n2.y };
    const cos = (n1.x * n2.x + n1.y * n2.y) / (half * half);
    const miterLength = half / Math.sqrt(Math.max(1e-6, (1 + cos) / 2));
    if (miterLength <= half * 4) {
      const length = Math.hypot(bisector.x, bisector.y) || 1;
      const tip = {
        x: at.x + (bisector.x / length) * miterLength * side,
        y: at.y + (bisector.y / length) * miterLength * side,
      };
      pieces.push([at, p1, tip, p2]);
    } else {
      pieces.push([at, p1, p2]);
    }
  }
  if (!closed && options.cap === "round") {
    pieces.push(circlePolygon(points[0], half, options.tolerance));
    pieces.push(circlePolygon(points[points.length - 1], half, options.tolerance));
  }
  return pieces;
}

/** Splits a polyline into dashes by arc length; `pattern` alternates on and off. */
export function dashPolyline(
  points: readonly CanvasPoint[],
  closed: boolean,
  pattern: readonly [number, number],
): CanvasPoint[][] {
  const path = closed && points.length > 1 ? [...points, points[0]] : [...points];
  const dashes: CanvasPoint[][] = [];
  let on = true;
  let left = pattern[0];
  let current: CanvasPoint[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    let from = path[i - 1];
    const to = path[i];
    let length = Math.hypot(to.x - from.x, to.y - from.y);
    while (length > left) {
      const t = left / length;
      const split = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      if (on) {
        current.push(split);
        dashes.push(current);
      }
      current = [split];
      on = !on;
      length -= left;
      left = pattern[on ? 0 : 1];
      from = split;
    }
    left -= length;
    if (on) current.push(to);
  }
  if (on && current.length > 1) dashes.push(current);
  return dashes;
}

export function polygonBounds(rings: readonly (readonly CanvasPoint[])[]) {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const point of ring) {
      x0 = Math.min(x0, point.x);
      y0 = Math.min(y0, point.y);
      x1 = Math.max(x1, point.x);
      y1 = Math.max(y1, point.y);
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Distance from `point` to the segment `a`–`b`. */
export function distanceToSegment(point: CanvasPoint, a: CanvasPoint, b: CanvasPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/** Even-odd containment, enough for the simple outlines shapes have. */
export function pointInPolygon(point: CanvasPoint, ring: readonly CanvasPoint[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Every piece of stroking `lines`, dashed by `pattern`, as one union to fill. */
export function strokePath(
  lines: readonly { points: readonly CanvasPoint[]; closed: boolean }[],
  options: {
    width: number;
    join: StrokeJoin;
    pattern: readonly [number, number] | null;
    tolerance: number;
  },
): FillPath {
  const rings: CanvasPoint[][] = [];
  for (const line of lines) {
    if (line.points.length === 0) continue;
    if (!options.pattern) {
      rings.push(
        ...strokePolygons(line.points, {
          closed: line.closed,
          width: options.width,
          join: options.join,
          cap: options.join === "round" ? "round" : "butt",
          tolerance: options.tolerance,
        }),
      );
      continue;
    }
    for (const dash of dashPolyline(line.points, line.closed, options.pattern)) {
      rings.push(
        ...strokePolygons(dash, {
          closed: false,
          width: options.width,
          join: "round",
          cap: "round",
          tolerance: options.tolerance,
        }),
      );
    }
  }
  return { rings, rule: "union" };
}
