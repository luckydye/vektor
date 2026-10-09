export interface FreehandPoint {
  x: number;
  y: number;
  pressure?: number;
  time?: number;
  velocity?: number;
  width?: number;
}

interface FreehandBezierSegment {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
  width?: number;
}

interface FreehandPath {
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

interface FreehandStrokeOptions {
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

interface FreehandVelocityWidthOptions {
  // Lower bound in world units. Defaults to 50% of style.width.
  minWidth?: number;
  // Upper bound in world units. Defaults to 180% of style.width.
  maxWidth?: number;
  // Multiplier for velocity before clamping. Higher values react more strongly.
  scale?: number;
  // Width retention per 60 Hz frame in [0,1]. It is normalized by elapsed
  // sample time, so coalesced high-frequency pointer events do not react more
  // sharply than lower-frequency events. Higher values smooth more.
  smoothing?: number;
  // By default faster strokes get thinner. Set true for faster strokes to get wider.
  invert?: boolean;
}

export interface FreehandStrokeBuilder {
  readonly points: readonly FreehandPoint[];
  addPoint(point: FreehandPoint): FreehandStroke;
  addPoints(points: Iterable<FreehandPoint>): FreehandStroke;
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

function resolveStyle(
  style: Partial<FreehandStrokeStyle> | undefined,
): FreehandStrokeStyle {
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

function cornerDamping(
  previous: FreehandPoint,
  current: FreehandPoint,
  next: FreehandPoint,
): number {
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

function pointSegmentDistanceSq(
  point: FreehandPoint,
  start: FreehandPoint,
  end: FreehandPoint,
): number {
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

function pointSegmentT(
  point: FreehandPoint,
  start: FreehandPoint,
  end: FreehandPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq),
  );
}

function widthInterpolationError(
  point: FreehandPoint,
  start: FreehandPoint,
  end: FreehandPoint,
): number {
  if (point.width === undefined || start.width === undefined || end.width === undefined)
    return 0;
  const t = pointSegmentT(point, start, end);
  const interpolatedWidth = start.width + (end.width - start.width) * t;
  return Math.abs(point.width - interpolatedWidth);
}

function filterFreehandPoints(
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

function simplifyFreehandPoints(
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
      const distSq = pointSegmentDistanceSq(
        points[i],
        points[startIndex],
        points[endIndex],
      );
      const widthError = widthInterpolationError(
        points[i],
        points[startIndex],
        points[endIndex],
      );
      const distanceScore =
        tolerance > 0
          ? Math.sqrt(distSq) / tolerance
          : distSq > 0
            ? Number.POSITIVE_INFINITY
            : 0;
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
  const referenceFrameMs = 1000 / 60;
  const elapsedMs = (previous: FreehandPoint, point: FreehandPoint) => {
    if (previous.time === undefined || point.time === undefined) {
      return referenceFrameMs;
    }
    return Math.max(1, point.time - previous.time);
  };
  const smoothingForElapsed = (dt: number) => smoothing ** (dt / referenceFrameMs);

  // When a point carries stylus pressure, width is driven by pressure directly.
  // Otherwise it is derived from pointer velocity (slower strokes are thicker).
  const targetWidthFor = (point: FreehandPoint, velocity: number): number => {
    if (point.pressure !== undefined) {
      const pressure = Math.max(0, Math.min(1, point.pressure));
      return minWidth + range * pressure;
    }
    const normalized = Math.max(0, Math.min(1, velocity * velocityScale));
    const t = options.invert ? normalized : 1 - normalized;
    return minWidth + range * t;
  };

  let previousWidth = style.width;

  let firstVelocity = 0;
  const hasFirstVelocity =
    scaled.length > 1 && scaled[0].time !== undefined && scaled[1].time !== undefined;
  if (hasFirstVelocity) {
    const firstDt = elapsedMs(scaled[0], scaled[1]);
    firstVelocity = Math.sqrt(distanceSq(scaled[1], scaled[0])) / firstDt;
  }
  scaled[0].velocity = firstVelocity;
  if (hasFirstVelocity || scaled[0].pressure !== undefined) {
    scaled[0].width = Math.max(
      minWidth,
      Math.min(maxWidth, targetWidthFor(scaled[0], firstVelocity)),
    );
  } else {
    scaled[0].width = Math.max(
      minWidth,
      Math.min(maxWidth, scaled[0].width ?? style.width),
    );
  }
  previousWidth = scaled[0].width;

  for (let i = 1; i < scaled.length; i++) {
    const previous = scaled[i - 1];
    const point = scaled[i];
    const dt = elapsedMs(previous, point);
    const velocity = Math.sqrt(distanceSq(point, previous)) / dt;
    const targetWidth = targetWidthFor(point, velocity);
    const blend = smoothingForElapsed(dt);
    const width = previousWidth * blend + targetWidth * (1 - blend);

    point.velocity = velocity;
    point.width = Math.max(minWidth, Math.min(maxWidth, width));
    previousWidth = point.width;
  }

  let nextWidth = scaled[scaled.length - 1].width ?? style.width;
  for (let i = scaled.length - 2; i >= 0; i--) {
    const point = scaled[i];
    const width = point.width ?? style.width;
    const blend = smoothingForElapsed(elapsedMs(point, scaled[i + 1]));
    point.width = Math.max(
      minWidth,
      Math.min(maxWidth, nextWidth * blend + width * (1 - blend)),
    );
    nextWidth = point.width;
  }

  return scaled;
}

function buildFreehandPathFromSizedPoints(
  points: readonly FreehandPoint[],
  style: FreehandStrokeStyle,
  options: Pick<
    FreehandStrokeOptions,
    "simplifyTolerance" | "simplifyWidthTolerance" | "smoothing"
  >,
): FreehandPath {
  const widthTolerance = options.simplifyWidthTolerance ?? style.width * 0.15;
  const simplified = simplifyFreehandPoints(
    points,
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
    // `retained` already has the distance filter and velocity widths applied.
    // Running the public path builder here used to do both passes a second time
    // for every live pointer update.
    path: buildFreehandPathFromSizedPoints(retained, style, options),
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

  function addPoints(nextPoints: Iterable<FreehandPoint>): FreehandStroke {
    const minDistance = options.minDistance ?? 0;
    const minDistanceSq = minDistance * minDistance;

    for (const point of nextPoints) {
      if (pendingStart) {
        const farEnough =
          minDistance <= 0 || distanceSq(point, pendingStart) >= minDistanceSq;
        if (!farEnough) continue;

        points.push(clonePoint(pendingStart), clonePoint(point));
        pendingStart = null;
        continue;
      }

      const farEnough =
        points.length === 0 ||
        minDistance <= 0 ||
        distanceSq(point, points[points.length - 1]) >= minDistanceSq;
      if (farEnough) points.push(clonePoint(point));
    }

    return makeStroke();
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
      return addPoints([point]);
    },
    addPoints(nextPoints) {
      return addPoints(nextPoints);
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

type StrokePointBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const boundsCache = new WeakMap<object, StrokePointBounds | null>();

/**
 * Cached min/max extent of a stroke's points.
 *
 * A committed stroke's points never change, so the answer is memoized against
 * the stroke's identity. Viewport culling and hit testing both ask for this on
 * every frame and every pointermove, and the rejection test has to be free for
 * the strokes that miss — walking every point of every stroke first is the
 * difference between a smooth canvas and a stuttery one.
 *
 * Typed structurally rather than against `CanvasStroke` so this library stays
 * independent of the extension types layered above it.
 */
export function strokePointBounds(stroke: {
  points: readonly FreehandPoint[];
}): StrokePointBounds | null {
  const cached = boundsCache.get(stroke);
  if (cached !== undefined) return cached;
  if (stroke.points.length === 0) {
    boundsCache.set(stroke, null);
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
  boundsCache.set(stroke, bounds);
  return bounds;
}

// ---------------------------------------------------------------------------
// Pen configuration
//
// The style and sampling a freehand stroke is built with. Lives here rather than
// with the layer that paints committed strokes: these describe what a stroke
// *is*, and both the draw tool and stroke deserialization need them without
// caring how the canvas caches its ink.
// ---------------------------------------------------------------------------

export const FREEHAND_STYLE: FreehandStrokeStyle = {
  color: "#111827",
  width: 10,
  opacity: 1,
  lineCap: "round",
  lineJoin: "round",
};

/**
 * How far velocity and pressure may take a stroke either side of its nominal
 * width, as a ratio of `style.width`.
 *
 * Ratios rather than absolutes: the width is chosen by the size control, and
 * hardcoded bounds would ignore it — which is exactly the bug this replaces.
 * At the default width of 10 these give the original 2..18 band.
 */
const FREEHAND_VELOCITY = {
  minRatio: 0.2,
  maxRatio: 1.8,
  smoothing: 0.72,
};

/**
 * The widest this stroke can actually be drawn.
 *
 * Painting pads culling and cache bounds by it: `style.width` is nominal, and
 * velocity can take a stroke wider.
 */
export function maxStrokeWidth(style: FreehandStrokeStyle): number {
  return style.width * FREEHAND_VELOCITY.maxRatio;
}

// The stroke reaches its thinnest at roughly this pointer speed in screen px/ms.
const SCREEN_VELOCITY_FULL = 2.4;

export function createFreehandOptions(
  style: FreehandStrokeStyle = FREEHAND_STYLE,
  worldToScreenScale = 1,
): FreehandStrokeOptions {
  const safeScreenScale = Math.max(0.01, worldToScreenScale);
  const screenPixelInWorld = 1 / safeScreenScale;
  return {
    // Sampling and simplification are perceptual values. Keeping them in
    // screen pixels prevents high zoom from turning a smooth gesture into a
    // sparse, angular polyline.
    minDistance: 2 * screenPixelInWorld,
    simplifyTolerance: 0.75 * screenPixelInWorld,
    smoothing: 0.9,
    style,
    velocityWidth: {
      minWidth: style.width * FREEHAND_VELOCITY.minRatio,
      maxWidth: style.width * FREEHAND_VELOCITY.maxRatio,
      smoothing: FREEHAND_VELOCITY.smoothing,
      scale: (1 / SCREEN_VELOCITY_FULL) * safeScreenScale,
    },
  };
}
