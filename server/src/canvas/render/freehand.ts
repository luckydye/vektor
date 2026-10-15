/**
 * Freehand strokes as stored: the smoothed centreline of a gesture, each point
 * carrying the width the hand gave it there. `render/ink.ts` draws the uniform
 * B-spline through these points, so they are control points, not a polyline.
 */

export interface FreehandPoint {
  x: number;
  y: number;
  width: number;
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
  style: FreehandStrokeStyle;
}

/** One pointer reading in world units; `pressure` only from a stylus. */
export interface FreehandSample {
  x: number;
  y: number;
  pressure: number | undefined;
  time: number;
}

export const FREEHAND_STYLE: FreehandStrokeStyle = {
  color: "#111827",
  width: 10,
  opacity: 1,
  lineCap: "round",
  lineJoin: "round",
};

// Tuned in screen pixels and milliseconds, after the reference ink brush.
const SLOW_WIDTH_FACTOR = 1.8;
const FAST_WIDTH_FACTOR = 0.35;
const MAX_WIDTH_VELOCITY = 0.9;
const LIGHT_PRESSURE_WIDTH_FACTOR = 0.2;
const HEAVY_PRESSURE_WIDTH_FACTOR = 1.8;
const INITIAL_VELOCITY_DISTANCE = 10;
const VELOCITY_WINDOW_DISTANCE = 8;
const MINIMUM_POINT_DISTANCE = 0.35;
const PRESSURE_SAMPLE_DELTA = 0.015;
const PRESSURE_RESPONSE_DELTA = 0.5;
const WIDTH_GROWTH_WIDTHS = 2;
const WIDTH_SHRINK_WIDTHS = 3.5;
const WIDTH_RESPONSE_MINIMUM = 16;
const SMOOTHING_RADIUS = 3;
const SIMPLIFY_TOLERANCE = 0.25;

/** The widest velocity or pressure can take a stroke; culling pads by it. */
export function maxStrokeWidth(style: FreehandStrokeStyle): number {
  return style.width * Math.max(SLOW_WIDTH_FACTOR, HEAVY_PRESSURE_WIDTH_FACTOR);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

type Reading = FreehandSample & { travelled: number; width: number | undefined };

export interface FreehandRecorder {
  add(samples: Iterable<FreehandSample>): void;
  /** Everything drawn so far, the unsettled tail included. */
  stroke(): FreehandStroke;
  /** The stroke to store, simplified; null when nothing was drawn. */
  finish(): FreehandStroke | null;
}

/**
 * Records a gesture into a stroke. `gestureScale` is world units per screen
 * pixel at the time of drawing, so the feel does not change with zoom.
 */
export function createFreehandRecorder(
  style: FreehandStrokeStyle,
  gestureScale: number,
): FreehandRecorder {
  const readings: Reading[] = [];
  let velocity: number | undefined;
  let velocityFrom = 0;

  function measuredVelocity(): number | undefined {
    const last = readings.length - 1;
    if (last < 1) return undefined;
    const end = readings[last];
    const opening = end.travelled - VELOCITY_WINDOW_DISTANCE * gestureScale;
    while (velocityFrom < last && readings[velocityFrom + 1].travelled <= opening) {
      velocityFrom += 1;
    }
    const start = readings[velocityFrom];
    if (start.time >= end.time) return undefined;
    // The window opens between two readings: time it from where it opens.
    const next = readings[velocityFrom + 1];
    const span = next.travelled - start.travelled;
    if (start.travelled < opening && opening < next.travelled && next.time < end.time) {
      const openedAt = lerp(start.time, next.time, (opening - start.travelled) / span);
      return VELOCITY_WINDOW_DISTANCE / (end.time - openedAt);
    }
    return (end.travelled - start.travelled) / gestureScale / (end.time - start.time);
  }

  function velocityWidth(): number {
    velocity = measuredVelocity() ?? velocity;
    // Unmeasured is not slow: a press or click shows the size it was set to.
    if (velocity === undefined) return style.width;
    const hurry = Math.min(velocity / MAX_WIDTH_VELOCITY, 1);
    return style.width * lerp(SLOW_WIDTH_FACTOR, FAST_WIDTH_FACTOR, hurry);
  }

  function tipWidth(reading: Reading, fromVelocity: number): number {
    if (reading.pressure === undefined) return fromVelocity;
    return (
      style.width *
      lerp(
        LIGHT_PRESSURE_WIDTH_FACTOR,
        HEAVY_PRESSURE_WIDTH_FACTOR,
        clamp01(reading.pressure),
      )
    );
  }

  function easedWidth(
    previous: number,
    target: number,
    movement: number,
    pressed: number,
  ) {
    const widths = target > previous ? WIDTH_GROWTH_WIDTHS : WIDTH_SHRINK_WIDTHS;
    const distance = Math.max(
      style.width * widths,
      WIDTH_RESPONSE_MINIMUM * gestureScale,
    );
    const response =
      1 - Math.exp(-movement / distance - pressed / PRESSURE_RESPONSE_DELTA);
    return lerp(previous, target, response);
  }

  // Width waits for enough travel to measure the opening speed, then lands on
  // every reading held back so far at once.
  function settleOpening() {
    const initial = velocityWidth();
    for (const reading of readings) reading.width = tipWidth(reading, initial);
  }

  function addSample(sample: FreehandSample) {
    const previous = readings.at(-1);
    if (!previous) {
      readings.push({ ...sample, travelled: 0, width: undefined });
      return;
    }
    const movement = Math.hypot(sample.x - previous.x, sample.y - previous.y);
    const pressed =
      sample.pressure !== undefined && previous.pressure !== undefined
        ? Math.abs(sample.pressure - previous.pressure)
        : 0;
    if (
      movement < MINIMUM_POINT_DISTANCE * gestureScale &&
      pressed < PRESSURE_SAMPLE_DELTA
    ) {
      return;
    }
    const reading: Reading = {
      ...sample,
      travelled: previous.travelled + movement,
      width: undefined,
    };
    readings.push(reading);
    if (previous.width === undefined) {
      if (reading.travelled >= INITIAL_VELOCITY_DISTANCE * gestureScale) settleOpening();
      return;
    }
    reading.width = easedWidth(
      previous.width,
      tipWidth(reading, velocityWidth()),
      movement,
      pressed,
    );
  }

  // A triangle-weighted mean over the readings within the smoothing radius
  // along the path; the reach shrinks towards the ends so they stay put.
  function smoothedAt(index: number, provisionalWidth: number): FreehandPoint {
    const centre = readings[index];
    const total = readings[readings.length - 1].travelled;
    const width = centre.width ?? provisionalWidth;
    const reach = Math.min(
      SMOOTHING_RADIUS * gestureScale,
      centre.travelled,
      total - centre.travelled,
    );
    if (reach <= 0) return { x: centre.x, y: centre.y, width };
    let x = 0;
    let y = 0;
    let weights = 0;
    for (let other = index; other >= 0; other -= 1) {
      const offset = centre.travelled - readings[other].travelled;
      if (offset > reach) break;
      const weight = 1 - offset / reach;
      x += readings[other].x * weight;
      y += readings[other].y * weight;
      weights += weight;
    }
    for (let other = index + 1; other < readings.length; other += 1) {
      const offset = readings[other].travelled - centre.travelled;
      if (offset > reach) break;
      const weight = 1 - offset / reach;
      x += readings[other].x * weight;
      y += readings[other].y * weight;
      weights += weight;
    }
    return { x: x / weights, y: y / weights, width };
  }

  function smoothed(): FreehandPoint[] {
    const provisional = readings[0]?.width === undefined ? velocityWidth() : 0;
    return readings.map((reading, index) =>
      smoothedAt(index, tipWidth(reading, provisional)),
    );
  }

  return {
    add(samples) {
      for (const sample of samples) addSample(sample);
    },
    stroke() {
      return { points: smoothed(), style };
    },
    finish() {
      if (readings.length === 0) return null;
      if (readings[0].width === undefined) settleOpening();
      const tolerance = SIMPLIFY_TOLERANCE * gestureScale;
      return { points: simplifyFreehandPoints(smoothed(), tolerance), style };
    },
  };
}

/** How far `point` lies from the segment, and the width it would interpolate. */
function segmentError(point: FreehandPoint, start: FreehandPoint, end: FreehandPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : clamp01(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq);
  return Math.max(
    Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t)),
    Math.abs(point.width - lerp(start.width, end.width, t)) / 2,
  );
}

/** Ramer-Douglas-Peucker over position and half width at once. */
function simplifyFreehandPoints(
  points: readonly FreehandPoint[],
  tolerance: number,
): FreehandPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  for (let span = stack.pop(); span; span = stack.pop()) {
    const [start, end] = span;
    let worst = tolerance;
    let worstIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const error = segmentError(points[index], points[start], points[end]);
      if (error > worst) {
        worst = error;
        worstIndex = index;
      }
    }
    if (worstIndex === -1) continue;
    keep[worstIndex] = true;
    stack.push([start, worstIndex], [worstIndex, end]);
  }
  return points.filter((_, index) => keep[index]);
}

type StrokePointBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const boundsCache = new WeakMap<object, StrokePointBounds | null>();

/**
 * Cached min/max extent of a stroke's points, memoized on the stroke's
 * identity since culling and hit testing ask for it every frame.
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
