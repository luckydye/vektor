import type { WorldTransform } from "./transform";

export interface FreehandPoint {
  x: number;
  y: number;
  pressure?: number;
  time?: number;
  velocity?: number;
  width?: number;
}

export interface FreehandBezierSegment {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
  width?: number;
}

export interface FreehandPath {
  start: FreehandPoint | null;
  segments: FreehandBezierSegment[];
}

export interface FreehandStrokeStyle {
  color: string;
  width: number;
  opacity: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
}

export interface FreehandStroke {
  points: FreehandPoint[];
  path: FreehandPath;
  style: FreehandStrokeStyle;
}

export interface FreehandStrokeOptions {
  // Minimum world-space distance between retained samples.
  minDistance?: number;
  // Ramer-Douglas-Peucker tolerance in world units. Set to 0 to keep all samples.
  simplifyTolerance?: number;
  // Maximum width error simplification may introduce. Defaults to 15% of style.width.
  simplifyWidthTolerance?: number;
  // Catmull-Rom smoothing strength. 0 produces straight cubic segments, 1 is standard.
  smoothing?: number;
  // Maps sample velocity in world units/ms to per-point stroke width.
  velocityWidth?: FreehandVelocityWidthOptions;
  style?: Partial<FreehandStrokeStyle>;
}

export interface FreehandVelocityWidthOptions {
  // Lower bound in world units. Defaults to 50% of style.width.
  minWidth?: number;
  // Upper bound in world units. Defaults to 180% of style.width.
  maxWidth?: number;
  // Multiplier for velocity before clamping. Higher values react more strongly.
  scale?: number;
  // Blend factor for consecutive widths in [0,1]. Higher values smooth more.
  smoothing?: number;
  // By default faster strokes get thinner. Set true for faster strokes to get wider.
  invert?: boolean;
}

export interface FreehandStrokeBuilder {
  readonly points: readonly FreehandPoint[];
  addPoint(point: FreehandPoint): FreehandStroke;
  startAt(point: FreehandPoint): FreehandStroke;
  getStroke(): FreehandStroke;
  finish(): FreehandStroke;
  reset(firstPoint?: FreehandPoint): void;
}

const DEFAULT_STYLE: FreehandStrokeStyle = {
  color: "#ffffff",
  width: 8,
  opacity: 1,
  lineCap: "round",
  lineJoin: "round",
};

function resolveStyle(style: Partial<FreehandStrokeStyle> | undefined): FreehandStrokeStyle {
  return { ...DEFAULT_STYLE, ...style };
}

function clonePoint(point: FreehandPoint): FreehandPoint {
  return {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
    time: point.time,
    velocity: point.velocity,
    width: point.width,
  };
}

function distanceSq(a: FreehandPoint, b: FreehandPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function distance(a: FreehandPoint, b: FreehandPoint): number {
  return Math.sqrt(distanceSq(a, b));
}

function cornerDamping(previous: FreehandPoint, current: FreehandPoint, next: FreehandPoint): number {
  const inX = current.x - previous.x;
  const inY = current.y - previous.y;
  const outX = next.x - current.x;
  const outY = next.y - current.y;
  const inLen = Math.hypot(inX, inY);
  const outLen = Math.hypot(outX, outY);
  if (inLen === 0 || outLen === 0) return 0;

  // Straight runs keep their smoothing. Right angles and tighter turns become
  // corner-like, which prevents cubic handles from crossing and forming loops.
  const dot = (inX * outX + inY * outY) / (inLen * outLen);
  return Math.max(0, Math.min(1, dot));
}

function clampedHandle(
  current: FreehandPoint,
  tangentPrevious: FreehandPoint,
  tangentNext: FreehandPoint,
  segmentLength: number,
  smoothing: number,
  damping: number,
) {
  const rawX = ((tangentNext.x - tangentPrevious.x) * smoothing * damping) / 6;
  const rawY = ((tangentNext.y - tangentPrevious.y) * smoothing * damping) / 6;
  const rawLength = Math.hypot(rawX, rawY);
  const maxLength = segmentLength * 0.4 * damping;
  if (rawLength === 0 || maxLength === 0) return { x: current.x, y: current.y };

  const scale = Math.min(1, maxLength / rawLength);
  return {
    x: current.x + rawX * scale,
    y: current.y + rawY * scale,
  };
}

function pointSegmentDistanceSq(point: FreehandPoint, start: FreehandPoint, end: FreehandPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distanceSq(point, start);

  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq),
  );
  const px = start.x + t * dx;
  const py = start.y + t * dy;
  const ox = point.x - px;
  const oy = point.y - py;
  return ox * ox + oy * oy;
}

function pointSegmentT(point: FreehandPoint, start: FreehandPoint, end: FreehandPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq));
}

function widthInterpolationError(
  point: FreehandPoint,
  start: FreehandPoint,
  end: FreehandPoint,
): number {
  if (point.width === undefined || start.width === undefined || end.width === undefined) return 0;
  const t = pointSegmentT(point, start, end);
  const interpolatedWidth = start.width + (end.width - start.width) * t;
  return Math.abs(point.width - interpolatedWidth);
}

export function filterFreehandPoints(
  points: readonly FreehandPoint[],
  minDistance = 0,
): FreehandPoint[] {
  if (points.length === 0) return [];
  if (minDistance <= 0) return points.map(clonePoint);

  const minDistanceSq = minDistance * minDistance;
  const filtered: FreehandPoint[] = [clonePoint(points[0])];
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (distanceSq(point, filtered[filtered.length - 1]) >= minDistanceSq) {
      filtered.push(clonePoint(point));
    }
  }

  const last = points[points.length - 1];
  const lastFiltered = filtered[filtered.length - 1];
  if (distanceSq(last, lastFiltered) > 0) {
    filtered.push(clonePoint(last));
  }
  return filtered;
}

export function simplifyFreehandPoints(
  points: readonly FreehandPoint[],
  tolerance = 0,
  widthTolerance = Number.POSITIVE_INFINITY,
): FreehandPoint[] {
  if (points.length <= 2 || (tolerance <= 0 && !Number.isFinite(widthTolerance))) {
    return points.map(clonePoint);
  }

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop()!;
    let maxScore = 0;
    let maxIndex = -1;

    for (let i = startIndex + 1; i < endIndex; i++) {
      const distSq = pointSegmentDistanceSq(points[i], points[startIndex], points[endIndex]);
      const widthError = widthInterpolationError(points[i], points[startIndex], points[endIndex]);
      const distanceScore =
        tolerance > 0 ? Math.sqrt(distSq) / tolerance : distSq > 0 ? Number.POSITIVE_INFINITY : 0;
      const widthScore =
        Number.isFinite(widthTolerance) && widthTolerance > 0
          ? widthError / widthTolerance
          : 0;
      const score = Math.max(distanceScore, widthScore);
      if (score > maxScore) {
        maxScore = score;
        maxIndex = i;
      }
    }

    if (maxIndex !== -1 && maxScore > 1) {
      keep[maxIndex] = true;
      stack.push([startIndex, maxIndex], [maxIndex, endIndex]);
    }
  }

  const simplified: FreehandPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) simplified.push(clonePoint(points[i]));
  }
  return simplified;
}

function addVelocityWidths(
  points: readonly FreehandPoint[],
  style: FreehandStrokeStyle,
  options: FreehandVelocityWidthOptions | undefined,
): FreehandPoint[] {
  const scaled = points.map(clonePoint);
  if (scaled.length === 0) return scaled;
  if (!options) {
    for (const point of scaled) point.width = point.width ?? style.width;
    return scaled;
  }

  const minWidth = options.minWidth ?? style.width * 0.5;
  const maxWidth = options.maxWidth ?? style.width * 1.8;
  const velocityScale = options.scale ?? 10;
  const smoothing = Math.max(0, Math.min(1, options.smoothing ?? 0.65));
  const range = Math.max(0, maxWidth - minWidth);
  let previousWidth = style.width;

  scaled[0].velocity = scaled[0].velocity ?? 0;
  if (scaled.length > 1 && scaled[0].time !== undefined && scaled[1].time !== undefined) {
    const firstDt = Math.max(1, scaled[1].time - scaled[0].time);
    const firstVelocity = Math.sqrt(distanceSq(scaled[1], scaled[0])) / firstDt;
    const firstNormalized = Math.max(0, Math.min(1, firstVelocity * velocityScale));
    const firstT = options.invert ? firstNormalized : 1 - firstNormalized;
    const firstTargetWidth = minWidth + range * firstT;
    scaled[0].velocity = firstVelocity;
    scaled[0].width = Math.max(minWidth, Math.min(maxWidth, firstTargetWidth));
    previousWidth = scaled[0].width;
  } else {
    scaled[0].width = Math.max(minWidth, Math.min(maxWidth, scaled[0].width ?? style.width));
  }

  for (let i = 1; i < scaled.length; i++) {
    const previous = scaled[i - 1];
    const point = scaled[i];
    const dt = Math.max(1, (point.time ?? i) - (previous.time ?? i - 1));
    const velocity = Math.sqrt(distanceSq(point, previous)) / dt;
    const normalized = Math.max(0, Math.min(1, velocity * velocityScale));
    const t = options.invert ? normalized : 1 - normalized;
    const targetWidth = minWidth + range * t;
    const width = previousWidth * smoothing + targetWidth * (1 - smoothing);

    point.velocity = velocity;
    point.width = Math.max(minWidth, Math.min(maxWidth, width));
    previousWidth = point.width;
  }

  let nextWidth = scaled[scaled.length - 1].width ?? style.width;
  for (let i = scaled.length - 2; i >= 0; i--) {
    const point = scaled[i];
    const width = point.width ?? style.width;
    point.width = Math.max(
      minWidth,
      Math.min(maxWidth, nextWidth * smoothing + width * (1 - smoothing)),
    );
    nextWidth = point.width;
  }

  return scaled;
}

export function buildFreehandPath(
  points: readonly FreehandPoint[],
  options: Pick<
    FreehandStrokeOptions,
    | "minDistance"
    | "simplifyTolerance"
    | "simplifyWidthTolerance"
    | "smoothing"
    | "style"
    | "velocityWidth"
  > = {},
): FreehandPath {
  const style = resolveStyle(options.style);
  const filtered = filterFreehandPoints(points, options.minDistance ?? 0);
  const sized = addVelocityWidths(filtered, style, options.velocityWidth);
  const widthTolerance = options.simplifyWidthTolerance ?? style.width * 0.15;
  const simplified = simplifyFreehandPoints(
    sized,
    options.simplifyTolerance ?? 0,
    widthTolerance,
  );
  if (simplified.length === 0) return { start: null, segments: [] };

  const smoothing = Math.max(0, Math.min(1, options.smoothing ?? 1));
  const segments: FreehandBezierSegment[] = [];

  for (let i = 0; i < simplified.length - 1; i++) {
    const p0 = simplified[Math.max(0, i - 1)];
    const p1 = simplified[i];
    const p2 = simplified[i + 1];
    const p3 = simplified[Math.min(simplified.length - 1, i + 2)];
    const segmentLength = distance(p1, p2);
    const p1Damping = i === 0 ? 1 : cornerDamping(p0, p1, p2);
    const p2Damping = i + 2 >= simplified.length ? 1 : cornerDamping(p1, p2, p3);
    const cp1 = clampedHandle(p1, p0, p2, segmentLength, smoothing, p1Damping);
    const cp2Forward = clampedHandle(p2, p1, p3, segmentLength, smoothing, p2Damping);

    segments.push({
      cp1x: cp1.x,
      cp1y: cp1.y,
      cp2x: p2.x - (cp2Forward.x - p2.x),
      cp2y: p2.y - (cp2Forward.y - p2.y),
      x: p2.x,
      y: p2.y,
      width: p2.width,
    });
  }

  return { start: clonePoint(simplified[0]), segments };
}

export function buildFreehandStroke(
  points: readonly FreehandPoint[],
  options: FreehandStrokeOptions = {},
): FreehandStroke {
  const style = resolveStyle(options.style);
  const retained = addVelocityWidths(
    filterFreehandPoints(points, options.minDistance ?? 0),
    style,
    options.velocityWidth,
  );
  return {
    points: retained,
    path: buildFreehandPath(retained, options),
    style,
  };
}

export function createFreehandStrokeBuilder(
  options: FreehandStrokeOptions = {},
): FreehandStrokeBuilder {
  let points: FreehandPoint[] = [];
  let pendingStart: FreehandPoint | null = null;

  function makeStroke(): FreehandStroke {
    return buildFreehandStroke(points, options);
  }

  return {
    get points() {
      return points;
    },
    startAt(point) {
      points = [];
      pendingStart = clonePoint(point);
      return makeStroke();
    },
    addPoint(point) {
      const minDistance = options.minDistance ?? 0;
      if (pendingStart) {
        const farEnough =
          minDistance <= 0 || distanceSq(point, pendingStart) >= minDistance * minDistance;
        if (!farEnough) return makeStroke();

        points.push(clonePoint(pendingStart), clonePoint(point));
        pendingStart = null;
        return makeStroke();
      }

      const farEnough =
        points.length === 0 ||
        minDistance <= 0 ||
        distanceSq(point, points[points.length - 1]) >= minDistance * minDistance;
      if (farEnough) {
        points.push(clonePoint(point));
      }
      return makeStroke();
    },
    getStroke() {
      return makeStroke();
    },
    finish() {
      pendingStart = null;
      return makeStroke();
    },
    reset(firstPoint) {
      points = firstPoint ? [clonePoint(firstPoint)] : [];
      pendingStart = null;
    },
  };
}

interface ScreenStrokeSample {
  x: number;
  y: number;
  width: number;
}

interface ScreenStrokeEdge {
  x: number;
  y: number;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function addEdgeCurve(ctx: CanvasRenderingContext2D, edge: readonly { x: number; y: number }[]) {
  if (edge.length === 0) return;
  ctx.lineTo(edge[0].x, edge[0].y);
  if (edge.length === 1) {
    return;
  }

  for (let i = 1; i < edge.length - 1; i++) {
    const midpointX = (edge[i].x + edge[i + 1].x) * 0.5;
    const midpointY = (edge[i].y + edge[i + 1].y) * 0.5;
    ctx.quadraticCurveTo(edge[i].x, edge[i].y, midpointX, midpointY);
  }

  const last = edge[edge.length - 1];
  ctx.lineTo(last.x, last.y);
}

function sampleFreehandPath(
  path: FreehandPath,
  transform: WorldTransform,
  style: FreehandStrokeStyle,
): ScreenStrokeSample[] {
  if (!path.start) return [];

  const samples: ScreenStrokeSample[] = [
    {
      x: path.start.x * transform.scale + transform.dx,
      y: path.start.y * transform.scale + transform.dy,
      width: Math.max(0.5, (path.start.width ?? style.width) * transform.scale),
    },
  ];

  let from = path.start;
  let fromWidth = path.start.width ?? style.width;

  for (const segment of path.segments) {
    const end: FreehandPoint = { x: segment.x, y: segment.y };
    const controlLength =
      Math.hypot(segment.cp1x - from.x, segment.cp1y - from.y) +
      Math.hypot(segment.cp2x - segment.cp1x, segment.cp2y - segment.cp1y) +
      Math.hypot(segment.x - segment.cp2x, segment.y - segment.cp2y);
    const sampleCount = Math.max(3, Math.min(32, Math.ceil((controlLength * transform.scale) / 8)));
    const toWidth = segment.width ?? style.width;

    for (let i = 1; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const width = fromWidth + (toWidth - fromWidth) * smoothstep(t);
      samples.push({
        x:
          cubic(from.x, segment.cp1x, segment.cp2x, segment.x, t) * transform.scale +
          transform.dx,
        y:
          cubic(from.y, segment.cp1y, segment.cp2y, segment.y, t) * transform.scale +
          transform.dy,
        width: Math.max(0.5, width * transform.scale),
      });
    }

    from = end;
    fromWidth = toWidth;
  }

  return samples;
}

function filterScreenSamples(samples: readonly ScreenStrokeSample[]): ScreenStrokeSample[] {
  if (samples.length <= 2) return samples.slice();

  const filtered: ScreenStrokeSample[] = [samples[0]];
  for (let i = 1; i < samples.length - 1; i++) {
    const previous = filtered[filtered.length - 1];
    const sample = samples[i];
    const dist = Math.hypot(sample.x - previous.x, sample.y - previous.y);
    const widthDelta = Math.abs(sample.width - previous.width);
    if (dist >= 0.75 || widthDelta >= 0.25) {
      filtered.push(sample);
    }
  }

  const last = samples[samples.length - 1];
  const previous = filtered[filtered.length - 1];
  if (Math.hypot(last.x - previous.x, last.y - previous.y) > 0) {
    filtered.push(last);
  }
  return filtered;
}

function tangentForSample(samples: readonly ScreenStrokeSample[], index: number) {
  const sample = samples[index];
  let previous = samples[Math.max(0, index - 1)];
  let next = samples[Math.min(samples.length - 1, index + 1)];

  for (let i = index - 2; i >= 0 && Math.hypot(sample.x - previous.x, sample.y - previous.y) < 1; i--) {
    previous = samples[i];
  }
  for (let i = index + 2; i < samples.length && Math.hypot(next.x - sample.x, next.y - sample.y) < 1; i++) {
    next = samples[i];
  }

  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  return { x: dx / len, y: dy / len };
}

function drawVariableWidthSamples(
  ctx: CanvasRenderingContext2D,
  samples: readonly ScreenStrokeSample[],
) {
  const filtered = filterScreenSamples(samples);
  if (filtered.length === 0) return;
  if (filtered.length === 1) {
    const sample = filtered[0];
    ctx.beginPath();
    ctx.arc(sample.x, sample.y, sample.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const left: ScreenStrokeEdge[] = [];
  const right: ScreenStrokeEdge[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const tangent = tangentForSample(filtered, i);
    if (!tangent) continue;

    const nx = -tangent.y;
    const ny = tangent.x;
    const halfWidth = filtered[i].width / 2;
    left.push({ x: filtered[i].x + nx * halfWidth, y: filtered[i].y + ny * halfWidth });
    right.push({ x: filtered[i].x - nx * halfWidth, y: filtered[i].y - ny * halfWidth });
  }

  if (left.length === 0 || right.length === 0) return;

  const start = filtered[0];
  const end = filtered[filtered.length - 1];
  const leftEnd = left[left.length - 1];
  const rightEnd = right[right.length - 1];
  const leftStart = left[0];
  const rightStart = right[0];

  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  addEdgeCurve(ctx, left);
  ctx.arc(
    end.x,
    end.y,
    end.width / 2,
    Math.atan2(leftEnd.y - end.y, leftEnd.x - end.x),
    Math.atan2(rightEnd.y - end.y, rightEnd.x - end.x),
    true,
  );
  addEdgeCurve(ctx, right.slice().reverse());
  ctx.arc(
    start.x,
    start.y,
    start.width / 2,
    Math.atan2(rightStart.y - start.y, rightStart.x - start.x),
    Math.atan2(leftStart.y - start.y, leftStart.x - start.x),
    true,
  );
  ctx.closePath();
  ctx.fill();
}

export function drawFreehandPath(
  ctx: CanvasRenderingContext2D,
  path: FreehandPath,
  transform: WorldTransform,
  style: FreehandStrokeStyle = DEFAULT_STYLE,
): void {
  if (!path.start) return;

  ctx.save();
  ctx.globalAlpha *= style.opacity;
  ctx.fillStyle = style.color;
  drawVariableWidthSamples(ctx, sampleFreehandPath(path, transform, style));
  ctx.restore();
}

export function drawFreehandStroke(
  ctx: CanvasRenderingContext2D,
  stroke: FreehandStroke,
  transform: WorldTransform,
): void {
  drawFreehandPath(ctx, stroke.path, transform, stroke.style);
}
