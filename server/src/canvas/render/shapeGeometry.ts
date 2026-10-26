/**
 * Geometry of the vector elements — `geo` outlines and `line` routes — as pure
 * functions, so the WebGL painters, hit testing and the server rasterizer all
 * draw the same picture from the same data.
 */

import type { CanvasFrame, CanvasPoint } from "#canvas/runtime/extensionApi.ts";
import { pointOnRotatedShape, rotatedShapeCorners } from "#canvas/runtime/geometry.ts";
import { distanceToSegment, flattenPath, type VectorNode } from "#canvas/render/vector.ts";

/** What geometry needs of any element: a line can bind to every type. */
export interface ShapeLike {
  id: string;
  type: string;
  frame: CanvasFrame;
  data: Record<string, unknown>;
}

export const GEO_KINDS = [
  "rect",
  "ellipse",
  "diamond",
  "triangle",
  "hexagon",
  "parallelogram",
  "star",
  "cylinder",
  "path",
] as const;
export type GeoKind = (typeof GEO_KINDS)[number];

export type StrokeDash = "solid" | "dashed" | "dotted";

/** Blank-line spacing in a shape's text, in em; the label editor's stylesheet matches it. */
export const GEO_PARAGRAPH_GAP = 0.6;

export interface GeoStyle {
  kind: GeoKind;
  stroke: string;
  strokeWidth: number;
  dash: StrokeDash;
  radius: number;
  /** Space between the outline's label area and the text. */
  padding: number;
  fontSize: number;
  /** Empty when the label should contrast with the fill. */
  textColor: string;
  align: "start" | "center" | "end";
  valign: "top" | "middle" | "bottom";
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

export function geoStyle(data: Record<string, unknown>): GeoStyle {
  return {
    kind: oneOf(data.kind, GEO_KINDS, "rect"),
    stroke: typeof data.stroke === "string" ? data.stroke : "#334155",
    strokeWidth: positive(data.strokeWidth, 2),
    dash: oneOf(data.dash, ["solid", "dashed", "dotted"] as const, "solid"),
    radius: positive(data.radius, 0),
    padding: positive(data.padding, 12),
    fontSize: positive(data.fontSize, 18) || 18,
    textColor: typeof data.textColor === "string" ? data.textColor : "",
    align: oneOf(data.align, ["start", "center", "end"] as const, "center"),
    valign: oneOf(data.valign, ["top", "middle", "bottom"] as const, "middle"),
  };
}

// Control-point distance that makes a cubic approximate a quarter circle.
const KAPPA = 0.5522847498;

function ellipseNodes(x: number, y: number, w: number, h: number): VectorNode[] {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { x: cx, y, in: { x: cx - kx, y }, out: { x: cx + kx, y } },
    { x: x + w, y: cy, in: { x: x + w, y: cy - ky }, out: { x: x + w, y: cy + ky } },
    { x: cx, y: y + h, in: { x: cx + kx, y: y + h }, out: { x: cx - kx, y: y + h } },
    { x, y: cy, in: { x, y: cy + ky }, out: { x, y: cy - ky } },
  ];
}

function roundedRectNodes(w: number, h: number, radius: number): VectorNode[] {
  const r = Math.min(radius, w / 2, h / 2);
  if (r <= 0) {
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  }
  const k = r * KAPPA;
  return [
    { x: r, y: 0, in: { x: r - k, y: 0 } },
    { x: w - r, y: 0, out: { x: w - r + k, y: 0 } },
    { x: w, y: r, in: { x: w, y: r - k } },
    { x: w, y: h - r, out: { x: w, y: h - r + k } },
    { x: w - r, y: h, in: { x: w - r + k, y: h } },
    { x: r, y: h, out: { x: r - k, y: h } },
    { x: 0, y: h - r, in: { x: 0, y: h - r + k } },
    { x: 0, y: r, out: { x: 0, y: r - k } },
  ];
}

function polygon(w: number, h: number, points: readonly [number, number][]) {
  return points.map(([x, y]) => ({ x: x * w, y: y * h }));
}

function starNodes(w: number, h: number): VectorNode[] {
  return Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? 0.5 : 0.21;
    return { x: (0.5 + Math.cos(angle) * radius) * w, y: (0.55 + Math.sin(angle) * radius) * h };
  });
}

/** A normalized path point, as stored in `data.points` of a "path" geo. */
export type StoredPathPoint = {
  x: number;
  y: number;
  in?: CanvasPoint;
  out?: CanvasPoint;
};

export function storedPathPoints(data: Record<string, unknown>): StoredPathPoint[] {
  if (!Array.isArray(data.points)) return [];
  const point = (value: unknown): CanvasPoint | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const { x, y } = value as Record<string, unknown>;
    return typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
  };
  return data.points.flatMap((value) => {
    const at = point(value);
    if (!at) return [];
    const record = value as Record<string, unknown>;
    return [{ ...at, in: point(record.in), out: point(record.out) }];
  });
}

export interface GeoOutline {
  /** In the shape's own unrotated frame, 0..width by 0..height. */
  nodes: VectorNode[];
  closed: boolean;
  /** Stroke-only details, such as a cylinder's front rim. */
  details: { nodes: VectorNode[]; closed: boolean }[];
}

export function geoOutline(kind: GeoKind, frame: CanvasFrame, data: Record<string, unknown>): GeoOutline {
  const { width: w, height: h } = frame;
  const shape = (nodes: VectorNode[]): GeoOutline => ({ nodes, closed: true, details: [] });
  switch (kind) {
    case "rect":
      return shape(roundedRectNodes(w, h, positive(data.radius, 0)));
    case "ellipse":
      return shape(ellipseNodes(0, 0, w, h));
    case "diamond":
      return shape(polygon(w, h, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]));
    case "triangle":
      return shape(polygon(w, h, [[0.5, 0], [1, 1], [0, 1]]));
    case "hexagon":
      return shape(polygon(w, h, [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]));
    case "parallelogram":
      return shape(polygon(w, h, [[0.2, 0], [1, 0], [0.8, 1], [0, 1]]));
    case "star":
      return shape(starNodes(w, h));
    case "cylinder": {
      const ry = Math.min(h * 0.15, w * 0.25);
      const rim = ellipseNodes(0, 0, w, ry * 2);
      const base = ellipseNodes(0, h - ry * 2, w, ry * 2);
      return {
        // Top half of the rim, down the right side, the bottom's lower half, up.
        nodes: [
          { ...rim[3], in: undefined },
          rim[0],
          { ...rim[1], out: undefined },
          { ...base[1], in: undefined },
          base[2],
          { ...base[3], out: undefined },
        ],
        closed: true,
        details: [{ nodes: [{ ...rim[1], in: undefined }, rim[2], { ...rim[3], out: undefined }], closed: false }],
      };
    }
    case "path":
      return {
        nodes: storedPathPoints(data).map((point) => ({
          x: point.x * w,
          y: point.y * h,
          in: point.in && { x: point.in.x * w, y: point.in.y * h },
          out: point.out && { x: point.out.x * w, y: point.out.y * h },
        })),
        closed: data.closed !== false,
        details: [],
      };
  }
}

/** Nodes moved from the shape's frame into world space, rotation included. */
export function nodesToWorld(frame: CanvasFrame, nodes: readonly VectorNode[]): VectorNode[] {
  const map = (point: CanvasPoint) => pointOnRotatedShape(frame, point);
  return nodes.map((node) => ({
    ...map(node),
    in: node.in && map(node.in),
    out: node.out && map(node.out),
  }));
}

/**
 * Where a label wraps inside a geo, in its own frame: the largest box that
 * sits comfortably within the outline, less padding.
 */
export function geoLabelBox(style: Pick<GeoStyle, "kind" | "padding">, frame: CanvasFrame) {
  const { kind, padding } = style;
  const { width: w, height: h } = frame;
  const inset: Record<GeoKind, [number, number, number, number]> = {
    // left, top, right, bottom as fractions of the frame
    rect: [0, 0, 0, 0],
    path: [0, 0, 0, 0],
    ellipse: [0.146, 0.146, 0.146, 0.146],
    diamond: [0.25, 0.25, 0.25, 0.25],
    triangle: [0.25, 0.45, 0.25, 0],
    hexagon: [0.12, 0, 0.12, 0],
    parallelogram: [0.18, 0, 0.18, 0],
    star: [0.32, 0.38, 0.32, 0.2],
    cylinder: [0, 0, 0, 0],
  };
  const [left, top, right, bottom] = inset[kind];
  const topExtra = kind === "cylinder" ? Math.min(h * 0.3, w * 0.5) : 0;
  return {
    x: left * w + padding,
    y: top * h + padding + topExtra,
    width: Math.max(1, w * (1 - left - right) - padding * 2),
    height: Math.max(1, h * (1 - top - bottom) - padding * 2 - topExtra),
  };
}

/** Relative luminance of a `#rrggbb` colour, or null for anything else. */
function luminance(color: string): number | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!match) return null;
  if (match[2] && Number.parseInt(match[2], 16) < 128) return null;
  const channel = (offset: number) => {
    const value = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Dark text on light fills, light on dark; `themeText` where the fill is see-through. */
export function contrastText(fill: string, themeText: string): string {
  const value = luminance(fill);
  if (value === null) return themeText;
  return value > 0.32 ? "#111827" : "#ffffff";
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export const LINE_ROUTES = ["straight", "elbow", "curve"] as const;
export type LineRoute = (typeof LINE_ROUTES)[number];
export const LINE_HEADS = ["none", "arrow", "triangle", "circle", "diamond"] as const;
export type LineHead = (typeof LINE_HEADS)[number];

/**
 * One end of a line. `x, y` is its free position in world units; with `shape`
 * it follows that element instead — to `anchor` (0..1 across its frame) when
 * given, else to the outline facing the other end. `x, y` stays the place it
 * falls back to if the element is deleted.
 */
export interface LineEnd {
  x: number;
  y: number;
  shape?: string;
  anchor?: CanvasPoint;
}

export interface LineStyle {
  color: string;
  route: LineRoute;
  start: LineHead;
  end: LineHead;
  width: number;
  dash: StrokeDash;
  fontSize: number;
  /** Where the label sits, 0 at the start to 1 at the end. */
  labelAt: number;
}

export function lineStyle(data: Record<string, unknown>): LineStyle {
  return {
    color: typeof data.stroke === "string" ? data.stroke : "#334155",
    route: oneOf(data.route, LINE_ROUTES, "straight"),
    start: oneOf(data.startHead, LINE_HEADS, "none"),
    end: oneOf(data.endHead, LINE_HEADS, "none"),
    width: positive(data.strokeWidth, 2) || 2,
    dash: oneOf(data.dash, ["solid", "dashed", "dotted"] as const, "solid"),
    fontSize: positive(data.fontSize, 14) || 14,
    labelAt: typeof data.labelAt === "number" ? Math.max(0, Math.min(1, data.labelAt)) : 0.5,
  };
}

/** Points a line passes through between its ends, in world units. */
export function lineVia(data: Record<string, unknown>): CanvasPoint[] {
  if (!Array.isArray(data.via)) return [];
  return data.via.flatMap((point) => {
    const { x, y } = (point ?? {}) as Record<string, unknown>;
    return typeof x === "number" && typeof y === "number" ? [{ x, y }] : [];
  });
}

export function lineEnd(value: unknown): LineEnd {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const anchor = record.anchor as Record<string, unknown> | undefined;
  return {
    x: typeof record.x === "number" ? record.x : 0,
    y: typeof record.y === "number" ? record.y : 0,
    shape: typeof record.shape === "string" ? record.shape : undefined,
    anchor:
      anchor && typeof anchor.x === "number" && typeof anchor.y === "number"
        ? { x: anchor.x, y: anchor.y }
        : undefined,
  };
}

/** A line as drawn: its polyline, and the direction each head points. */
export interface LineGeometry {
  points: CanvasPoint[];
  start: { at: CanvasPoint; direction: CanvasPoint };
  end: { at: CanvasPoint; direction: CanvasPoint };
}

/** The outline a line clips against: a geo's own shape, or the rotated frame. */
export function shapeOutline(shape: ShapeLike, tolerance: number): CanvasPoint[] {
  if (shape.type === "geo") {
    const style = geoStyle(shape.data);
    const outline = geoOutline(style.kind, shape.frame, shape.data);
    if (outline.closed && outline.nodes.length > 2) {
      return flattenPath(nodesToWorld(shape.frame, outline.nodes), true, tolerance);
    }
  }
  return rotatedShapeCorners(shape.frame);
}

function center(frame: CanvasFrame): CanvasPoint {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** Where the ray from `from` toward `to` last leaves `ring`; null if it never crosses it. */
function exitPoint(ring: readonly CanvasPoint[], from: CanvasPoint, to: CanvasPoint) {
  let best: { t: number; point: CanvasPoint } | null = null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denominator;
    const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / denominator;
    if (t < 0 || u < 0 || u > 1) continue;
    if (!best || t > best.t) best = { t, point: { x: from.x + dx * t, y: from.y + dy * t } };
  }
  return best?.point ?? null;
}

type Side = "top" | "right" | "bottom" | "left";
const SIDE_DIRECTION: Record<Side, CanvasPoint> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

function facingSide(frame: CanvasFrame, toward: CanvasPoint): Side {
  const c = center(frame);
  const dx = (toward.x - c.x) / Math.max(1, frame.width);
  const dy = (toward.y - c.y) / Math.max(1, frame.height);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

function sidePoint(frame: CanvasFrame, side: Side): CanvasPoint {
  const local = {
    top: { x: frame.width / 2, y: 0 },
    right: { x: frame.width, y: frame.height / 2 },
    bottom: { x: frame.width / 2, y: frame.height },
    left: { x: 0, y: frame.height / 2 },
  }[side];
  return pointOnRotatedShape(frame, local);
}

/** Space left between a bound end and the outline it meets. */
const BIND_GAP = 6;

interface ResolvedEnd {
  at: CanvasPoint;
  /** Outward from the bound shape, or null for a free end. */
  normal: CanvasPoint | null;
}

function unit(vector: CanvasPoint): CanvasPoint {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

export function resolveLine(
  data: Record<string, unknown>,
  lookup: (id: string) => ShapeLike | undefined,
  tolerance: number,
): LineGeometry {
  const style = lineStyle(data);
  const ends = [lineEnd(data.start), lineEnd(data.end)] as const;
  const targets = ends.map((end) => (end.shape ? lookup(end.shape) : undefined));
  // Where each end aims before clipping: an anchor, an element's centre, or its point.
  const aims = ends.map((end, i) => {
    const target = targets[i];
    if (!target) return { x: end.x, y: end.y };
    if (end.anchor) {
      return pointOnRotatedShape(target.frame, {
        x: end.anchor.x * target.frame.width,
        y: end.anchor.y * target.frame.height,
      });
    }
    return center(target.frame);
  });

  const via = lineVia(data);
  const resolve = (index: 0 | 1): ResolvedEnd => {
    const end = ends[index];
    const target = targets[index];
    // An end faces the nearest point the line passes through.
    const other = (index === 0 ? via[0] : via[via.length - 1]) ?? aims[1 - index];
    if (!target) return { at: aims[index], normal: null };
    if (end.anchor) {
      const at = aims[index];
      return { at, normal: unit({ x: at.x - center(target.frame).x, y: at.y - center(target.frame).y }) };
    }
    if (style.route === "elbow") {
      const side = facingSide(target.frame, other);
      const normal = SIDE_DIRECTION[side];
      const at = sidePoint(target.frame, side);
      return { at: { x: at.x + normal.x * BIND_GAP, y: at.y + normal.y * BIND_GAP }, normal };
    }
    const from = center(target.frame);
    const hit = exitPoint(shapeOutline(target, tolerance), from, other);
    if (!hit) return { at: from, normal: null };
    const normal = unit({ x: other.x - from.x, y: other.y - from.y });
    return { at: { x: hit.x + normal.x * BIND_GAP, y: hit.y + normal.y * BIND_GAP }, normal };
  };

  const start = resolve(0);
  const end = resolve(1);
  const points =
    via.length > 0
      ? viaRoute(style.route, start, via, end, tolerance)
      : style.route === "elbow"
        ? elbowRoute(start, end)
        : style.route === "curve"
          ? curveRoute(start, end, tolerance)
          : [start.at, end.at];
  const last = points.length - 1;
  return {
    points,
    start: { at: points[0], direction: unit({ x: points[0].x - points[1].x, y: points[0].y - points[1].y }) },
    end: {
      at: points[last],
      direction: unit({ x: points[last].x - points[last - 1].x, y: points[last].y - points[last - 1].y }),
    },
  };
}

function axisOf(normal: CanvasPoint | null, from: CanvasPoint, to: CanvasPoint): "x" | "y" {
  if (normal) return Math.abs(normal.x) > Math.abs(normal.y) ? "x" : "y";
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? "x" : "y";
}

/** Right angles only: out of each end along its side, meeting in the middle. */
function elbowRoute(start: ResolvedEnd, end: ResolvedEnd): CanvasPoint[] {
  const a = start.at;
  const b = end.at;
  const startAxis = axisOf(start.normal, a, b);
  const endAxis = axisOf(end.normal, b, a);
  let points: CanvasPoint[];
  if (startAxis === "x" && endAxis === "x") {
    const mid = (a.x + b.x) / 2;
    points = [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
  } else if (startAxis === "y" && endAxis === "y") {
    const mid = (a.y + b.y) / 2;
    points = [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
  } else if (startAxis === "x") {
    points = [a, { x: b.x, y: a.y }, b];
  } else {
    points = [a, { x: a.x, y: b.y }, b];
  }
  // Drop bends that collapsed onto their neighbours.
  return points.filter(
    (point, i) =>
      i === 0 ||
      i === points.length - 1 ||
      Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) > 0.5,
  );
}

/** A route through waypoints: corners between them for elbow, a smooth spline for curve. */
function viaRoute(
  route: LineRoute,
  start: ResolvedEnd,
  via: readonly CanvasPoint[],
  end: ResolvedEnd,
  tolerance: number,
): CanvasPoint[] {
  const stops = [start.at, ...via, end.at];
  if (route === "straight") return stops;
  if (route === "curve") {
    const nodes = stops.map((point, i) => {
      const before = stops[Math.max(0, i - 1)];
      const after = stops[Math.min(stops.length - 1, i + 1)];
      const tangent = { x: (after.x - before.x) / 6, y: (after.y - before.y) / 6 };
      return {
        ...point,
        in: { x: point.x - tangent.x, y: point.y - tangent.y },
        out: { x: point.x + tangent.x, y: point.y + tangent.y },
      };
    });
    return flattenPath(nodes, false, tolerance);
  }
  let axis = axisOf(start.normal, stops[0], stops[1]);
  const points = [stops[0]];
  for (const next of stops.slice(1)) {
    const current = points[points.length - 1];
    if (Math.abs(current.x - next.x) > 0.5 && Math.abs(current.y - next.y) > 0.5) {
      points.push(axis === "x" ? { x: next.x, y: current.y } : { x: current.x, y: next.y });
      axis = axis === "x" ? "y" : "x";
    }
    points.push(next);
  }
  return points;
}

function curveRoute(start: ResolvedEnd, end: ResolvedEnd, tolerance: number): CanvasPoint[] {
  const a = start.at;
  const b = end.at;
  const reach = Math.hypot(b.x - a.x, b.y - a.y) * 0.4;
  const handle = (from: ResolvedEnd, to: CanvasPoint) => {
    const direction = from.normal ?? unit({ x: to.x - from.at.x, y: to.y - from.at.y });
    return { x: from.at.x + direction.x * reach, y: from.at.y + direction.y * reach };
  };
  if (!start.normal && !end.normal) return [a, b];
  return flattenPath(
    [
      { ...a, out: handle(start, b) },
      { ...b, in: handle(end, a) },
    ],
    false,
    tolerance,
  );
}

/** Polygon or polyline pieces for one line head, in world units. */
export function lineHead(
  head: LineHead,
  tip: { at: CanvasPoint; direction: CanvasPoint },
  width: number,
): { fill: CanvasPoint[] | null; stroke: CanvasPoint[] | null; inset: number } {
  const size = 6 + width * 2.5;
  const { at, direction: d } = tip;
  const back = (distance: number, spread: number) => ({
    x: at.x - d.x * distance - d.y * spread,
    y: at.y - d.y * distance + d.x * spread,
  });
  switch (head) {
    case "none":
      return { fill: null, stroke: null, inset: 0 };
    case "arrow":
      return { fill: null, stroke: [back(size, size * 0.6), at, back(size, -size * 0.6)], inset: 0 };
    case "triangle":
      return { fill: [at, back(size * 1.2, size * 0.6), back(size * 1.2, -size * 0.6)], stroke: null, inset: size };
    case "diamond":
      return {
        fill: [at, back(size * 0.8, size * 0.5), back(size * 1.6, 0), back(size * 0.8, -size * 0.5)],
        stroke: null,
        inset: size * 1.4,
      };
    case "circle": {
      const radius = size * 0.45;
      const c = back(radius, 0);
      return {
        fill: Array.from({ length: 16 }, (_, i) => ({
          x: c.x + Math.cos((i / 16) * Math.PI * 2) * radius,
          y: c.y + Math.sin((i / 16) * Math.PI * 2) * radius,
        })),
        stroke: null,
        inset: radius,
      };
    }
  }
}

/** The polyline with each end pulled back by `startInset`/`endInset`, so heads cover its tip. */
export function insetPolyline(points: readonly CanvasPoint[], startInset: number, endInset: number) {
  const result = points.map((point) => ({ ...point }));
  const pull = (index: number, neighbour: number, inset: number) => {
    if (inset <= 0) return;
    const a = result[index];
    const b = result[neighbour];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Math.min(inset, length * 0.9) / (length || 1);
    result[index] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  pull(0, 1, startInset);
  pull(result.length - 1, result.length - 2, endInset);
  return result;
}

/** The point a share `t` (0..1) of the way along the polyline, e.g. for its label. */
export function polylinePointAt(points: readonly CanvasPoint[], t: number): CanvasPoint {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let left = total * t;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length) {
      const t = length === 0 ? 0 : left / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= length;
  }
  return points[points.length - 1];
}

/**
 * The centre of a line's label. On the line when there is room either side of
 * it; a label too wide for a short line sits beside it instead of hiding it.
 */
export function lineLabelCenter(
  points: readonly CanvasPoint[],
  t: number,
  label: { width: number; height: number },
): CanvasPoint {
  const at = polylinePointAt(points, t);
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (label.width <= length * 0.6) return at;
  const before = polylinePointAt(points, Math.max(0, t - 0.01));
  const after = polylinePointAt(points, Math.min(1, t + 0.01));
  const direction = unit({ x: after.x - before.x, y: after.y - before.y });
  // Above a horizontal-ish line, right of a vertical-ish one.
  const horizontal = Math.abs(direction.x) >= Math.abs(direction.y);
  return horizontal
    ? { x: at.x, y: at.y - label.height / 2 - 6 }
    : { x: at.x + label.width / 2 + 8, y: at.y };
}

export function distanceToPolyline(point: CanvasPoint, points: readonly CanvasPoint[]) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, distanceToSegment(point, points[i - 1], points[i]));
  }
  return best;
}

export function dashPattern(dash: StrokeDash, width: number): [number, number] | null {
  if (dash === "dashed") return [width * 4 + 4, width * 3 + 3];
  if (dash === "dotted") return [0.01, width * 2.2 + 1.5];
  return null;
}
