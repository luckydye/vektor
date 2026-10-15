/**
 * Freehand ink on the GPU. Each stroke is tessellated once, in world space, into
 * a mesh whose vertices carry their centreline point, outward normal and half
 * width, so panning and zooming only change uniforms and the vertex shader can
 * grow a silhouette by a constant number of screen pixels for selection rings.
 */

import {
  FREEHAND_STYLE,
  type FreehandPoint,
  type FreehandStroke,
  maxStrokeWidth,
  strokePointBounds,
} from "#canvas/render/freehand.ts";
import {
  type CanvasGpu,
  parseColor,
  type Rgba,
  setColor,
  useProgram,
} from "#canvas/render/webgl.ts";
import type { CanvasPoint } from "#canvas/runtime/geometry.ts";

/** Strokes under a move drag: drawn at an offset instead of being re-tessellated. */
export interface InkOffset {
  strokes: ReadonlySet<FreehandStroke>;
  dx: number;
  dy: number;
}

interface InkMesh {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

interface InkSample {
  x: number;
  y: number;
  radius: number;
}

// A curve is split until its handles lie within this share of its chord.
const FLATNESS = 0.01;
const MAX_CURVE_DEPTH = 6;
const FAN_STEP = Math.PI / 16;

function mirrored(origin: FreehandPoint, toward: FreehandPoint): FreehandPoint {
  return {
    x: origin.x * 2 - toward.x,
    y: origin.y * 2 - toward.y,
    width: origin.width * 2 - toward.width,
  };
}

function distanceToChord(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq),
        );
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function flattenCubic(
  start: CanvasPoint,
  one: CanvasPoint,
  two: CanvasPoint,
  end: CanvasPoint,
  amounts: [number, number],
  depth: number,
  out: number[],
) {
  const tolerance = FLATNESS * Math.hypot(end.x - start.x, end.y - start.y);
  if (
    depth >= MAX_CURVE_DEPTH ||
    Math.max(distanceToChord(one, start, end), distanceToChord(two, start, end)) <=
      tolerance
  ) {
    out.push(amounts[1]);
    return;
  }
  const mid = (a: CanvasPoint, b: CanvasPoint) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const startOne = mid(start, one);
  const oneTwo = mid(one, two);
  const twoEnd = mid(two, end);
  const leftTwo = mid(startOne, oneTwo);
  const rightOne = mid(oneTwo, twoEnd);
  const split = mid(leftTwo, rightOne);
  const middle = (amounts[0] + amounts[1]) / 2;
  flattenCubic(start, startOne, leftTwo, split, [amounts[0], middle], depth + 1, out);
  flattenCubic(split, rightOne, twoEnd, end, [middle, amounts[1]], depth + 1, out);
}

/**
 * The uniform cubic B-spline through the control points, flattened. Mirrored
 * phantom points at both ends make the curve start and end on them.
 */
function curveSamples(points: readonly FreehandPoint[]): InkSample[] {
  const control = (index: number) =>
    index < 0
      ? mirrored(points[0], points[1])
      : index >= points.length
        ? mirrored(points[points.length - 1], points[points.length - 2])
        : points[index];
  const knot = (a: FreehandPoint, b: FreehandPoint, c: FreehandPoint) => ({
    x: (a.x + b.x * 4 + c.x) / 6,
    y: (a.y + b.y * 4 + c.y) / 6,
    width: (a.width + b.width * 4 + c.width) / 6,
  });
  const first = points[0];
  const samples: InkSample[] = [{ x: first.x, y: first.y, radius: first.width / 2 }];
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = control(index - 1);
    const from = points[index];
    const to = points[index + 1];
    const after = control(index + 2);
    const start = knot(before, from, to);
    const end = knot(from, to, after);
    const one = { x: (from.x * 2 + to.x) / 3, y: (from.y * 2 + to.y) / 3 };
    const two = { x: (from.x + to.x * 2) / 3, y: (from.y + to.y * 2) / 3 };
    const amounts: number[] = [];
    flattenCubic(start, one, two, end, [0, 1], 0, amounts);
    for (const t of amounts) {
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      samples.push({
        x: a * start.x + b * one.x + c * two.x + d * end.x,
        y: a * start.y + b * one.y + c * two.y + d * end.y,
        radius: (start.width + (end.width - start.width) * t) / 2,
      });
    }
  }
  return samples;
}

// A circle inside its neighbour adds nothing to the silhouette and leaves no
// tangent between the two, so it is dropped.
function withoutNested(samples: readonly InkSample[]): InkSample[] {
  const inside = (inner: InkSample, outer: InkSample) =>
    Math.hypot(inner.x - outer.x, inner.y - outer.y) + inner.radius <= outer.radius;
  const kept: InkSample[] = [];
  for (const sample of samples) {
    const last = kept.at(-1);
    if (last && inside(sample, last)) continue;
    while (kept.length > 0 && inside(kept[kept.length - 1], sample)) kept.pop();
    kept.push(sample);
  }
  return kept;
}

function wrapped(angle: number): number {
  return angle - Math.PI * 2 * Math.round(angle / (Math.PI * 2));
}

/**
 * The stroke as a chain of tapered capsules: per span the trapezoid along both
 * circles' outer tangents, round wedges where spans meet, round caps at the
 * ends. Interleaved per vertex: centre (2), normal (2), half width (1).
 */
function tessellate(stroke: FreehandStroke): Float32Array {
  const samples = withoutNested(curveSamples(stroke.points));
  const data: number[] = [];
  const vertex = (s: InkSample, angle: number | null) => {
    if (angle === null) data.push(s.x, s.y, 0, 0, s.radius);
    else data.push(s.x, s.y, Math.cos(angle), Math.sin(angle), s.radius);
  };
  const fan = (s: InkSample, from: number, sweep: number) => {
    const steps = Math.ceil(Math.abs(sweep) / FAN_STEP);
    for (let i = 0; i < steps; i++) {
      vertex(s, null);
      vertex(s, from + (sweep * i) / steps);
      vertex(s, from + (sweep * (i + 1)) / steps);
    }
  };

  if (samples.length === 1) {
    fan(samples[0], 0, Math.PI * 2);
    return new Float32Array(data);
  }

  // Where a side touches both circles, its normal u satisfies
  // u·direction = (r0 - r1) / length.
  const spans = samples.slice(1).map((to, index) => {
    const from = samples[index];
    const heading = Math.atan2(to.y - from.y, to.x - from.x);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const spread = Math.acos((from.radius - to.radius) / length);
    return { from, to, left: heading + spread, right: heading - spread, spread };
  });
  // Spans are fanned from their centres: a tapered span's end edge misses the
  // centre, and the wedges around a joint only close the gap at the centre.
  const triangle = (...corners: [InkSample, number | null][]) => {
    for (const [sample, angle] of corners) vertex(sample, angle);
  };
  for (const [index, span] of spans.entries()) {
    triangle([span.from, null], [span.from, span.left], [span.to, span.left]);
    triangle([span.from, null], [span.to, span.left], [span.to, null]);
    triangle([span.from, null], [span.to, null], [span.to, span.right]);
    triangle([span.from, null], [span.to, span.right], [span.from, span.right]);
    const previous = spans[index - 1];
    if (!previous) continue;
    fan(span.from, previous.left, wrapped(span.left - previous.left));
    fan(span.from, previous.right, wrapped(span.right - previous.right));
  }
  const first = spans[0];
  const last = spans[spans.length - 1];
  fan(first.from, first.left, Math.PI * 2 - first.spread * 2);
  fan(last.to, last.right, last.spread * 2);
  return new Float32Array(data);
}

function createMesh(gpu: CanvasGpu): InkMesh {
  const { gl } = gpu;
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) throw new Error("Ink mesh allocation failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
  gl.bindVertexArray(null);
  return { vao, buffer, count: 0 };
}

function upload(gpu: CanvasGpu, mesh: InkMesh, stroke: FreehandStroke, usage: number) {
  const data = tessellate(stroke);
  gpu.gl.bindBuffer(gpu.gl.ARRAY_BUFFER, mesh.buffer);
  gpu.gl.bufferData(gpu.gl.ARRAY_BUFFER, data, usage);
  mesh.count = data.length / 5;
}

// A stroke's points never change in place, so they key its mesh.
function meshFor(gpu: CanvasGpu, stroke: FreehandStroke): InkMesh {
  const cached = gpu.resources.objects.get(stroke.points) as InkMesh | undefined;
  if (cached) return cached;
  const mesh = createMesh(gpu);
  upload(gpu, mesh, stroke, gpu.gl.STATIC_DRAW);
  gpu.resources.objects.set(stroke.points, mesh);
  return mesh;
}

// The stroke under the pen is rebuilt on every pointer move, so it streams
// through one reused buffer rather than leaving a mesh per frame behind.
function activeMesh(gpu: CanvasGpu, stroke: FreehandStroke): InkMesh {
  let mesh = gpu.resources.named.get("activeInk") as InkMesh | undefined;
  if (!mesh) {
    mesh = createMesh(gpu);
    gpu.resources.named.set("activeInk", mesh);
  }
  upload(gpu, mesh, stroke, gpu.gl.DYNAMIC_DRAW);
  return mesh;
}

// Sub-pixel strokes keep a quarter-pixel half width so a zoomed-out sketch
// thins out rather than vanishing.
const INK_VERTEX = `
layout(location = 0) in vec2 a_center;
layout(location = 1) in vec2 a_normal;
layout(location = 2) in float a_halfWidth;
uniform vec2 u_offset;
uniform float u_expand;
void main() {
  vec2 center = worldToScreen(a_center + u_offset);
  gl_Position = screenToClip(center + a_normal * (max(a_halfWidth * u_view.x, 0.25) + u_expand));
}
`;

const INK_FRAGMENT = `
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }
`;

function offsetOf(stroke: FreehandStroke, moved: InkOffset | null): CanvasPoint {
  return moved?.strokes.has(stroke) ? { x: moved.dx, y: moved.dy } : { x: 0, y: 0 };
}

function strokeColor(stroke: FreehandStroke, defaultInkColor: string): Rgba {
  return parseColor(
    stroke.style.color === FREEHAND_STYLE.color ? defaultInkColor : stroke.style.color,
  );
}

function isOnScreen(gpu: CanvasGpu, stroke: FreehandStroke, offset: CanvasPoint) {
  const bounds = strokePointBounds(stroke);
  if (!bounds) return false;
  const { transform, screen } = gpu.view;
  const padding = maxStrokeWidth(stroke.style);
  const minX = -transform.dx / transform.scale - offset.x;
  const minY = -transform.dy / transform.scale - offset.y;
  const maxX = (screen.width - transform.dx) / transform.scale - offset.x;
  const maxY = (screen.height - transform.dy) / transform.scale - offset.y;
  return !(
    bounds.maxX + padding < minX ||
    bounds.minX - padding > maxX ||
    bounds.maxY + padding < minY ||
    bounds.minY - padding > maxY
  );
}

/**
 * Fills strokes in order. Each stroke stamps its own stencil value, so where a
 * stroke overlaps itself a translucent colour is not blended twice.
 */
export function drawStrokes(
  gpu: CanvasGpu,
  strokes: readonly FreehandStroke[],
  defaultInkColor: string,
  moved: InkOffset | null = null,
) {
  const { gl } = gpu;
  const program = useProgram(gpu, "ink", INK_VERTEX, INK_FRAGMENT);
  gl.uniform1f(program.uniform("u_expand"), 0);
  gl.enable(gl.STENCIL_TEST);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  let ref = 0;
  for (const stroke of strokes) {
    const offset = offsetOf(stroke, moved);
    if (!isOnScreen(gpu, stroke, offset)) continue;
    ref = (ref % 255) + 1;
    if (ref === 1) gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilFunc(gl.NOTEQUAL, ref, 0xff);
    const mesh = meshFor(gpu, stroke);
    gl.uniform2f(program.uniform("u_offset"), offset.x, offset.y);
    setColor(
      gpu,
      program.uniform("u_color"),
      strokeColor(stroke, defaultInkColor),
      stroke.style.opacity,
    );
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }
  gl.bindVertexArray(null);
  gl.disable(gl.STENCIL_TEST);
}

/** The stroke under the pen, streamed rather than cached. */
export function drawActiveStroke(
  gpu: CanvasGpu,
  stroke: FreehandStroke,
  defaultInkColor: string,
) {
  const { gl } = gpu;
  const program = useProgram(gpu, "ink", INK_VERTEX, INK_FRAGMENT);
  const mesh = activeMesh(gpu, stroke);
  gl.uniform1f(program.uniform("u_expand"), 0);
  gl.uniform2f(program.uniform("u_offset"), 0, 0);
  setColor(
    gpu,
    program.uniform("u_color"),
    strokeColor(stroke, defaultInkColor),
    stroke.style.opacity,
  );
  gl.enable(gl.STENCIL_TEST);
  gl.clear(gl.STENCIL_BUFFER_BIT);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
  gl.bindVertexArray(mesh.vao);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  gl.bindVertexArray(null);
  gl.disable(gl.STENCIL_TEST);
}

/**
 * A ring of `lineWidth` screen pixels, `expand` pixels outside each stroke's
 * silhouette. Rings around overlapping strokes merge: every inner silhouette
 * is masked out before any ring is drawn.
 */
export function drawStrokeRings(
  gpu: CanvasGpu,
  groups: readonly { strokes: readonly FreehandStroke[]; color: string }[],
  moved: InkOffset | null = null,
  expand = 2,
  lineWidth = 1.5,
) {
  if (groups.every((group) => group.strokes.length === 0)) return;
  const { gl } = gpu;
  const program = useProgram(gpu, "ink", INK_VERTEX, INK_FRAGMENT);
  const drawAll = (strokes: readonly FreehandStroke[]) => {
    for (const stroke of strokes) {
      const offset = offsetOf(stroke, moved);
      const mesh = meshFor(gpu, stroke);
      gl.uniform2f(program.uniform("u_offset"), offset.x, offset.y);
      gl.bindVertexArray(mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
  };

  gl.enable(gl.STENCIL_TEST);
  gl.clear(gl.STENCIL_BUFFER_BIT);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  gl.colorMask(false, false, false, false);
  gl.stencilFunc(gl.ALWAYS, 1, 0xff);
  gl.uniform1f(program.uniform("u_expand"), expand - lineWidth / 2);
  for (const group of groups) drawAll(group.strokes);

  gl.colorMask(true, true, true, true);
  gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
  gl.uniform1f(program.uniform("u_expand"), expand + lineWidth / 2);
  for (const group of groups) {
    setColor(gpu, program.uniform("u_color"), parseColor(group.color));
    drawAll(group.strokes);
  }
  gl.bindVertexArray(null);
  gl.disable(gl.STENCIL_TEST);
}
