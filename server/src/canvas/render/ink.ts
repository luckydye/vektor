/**
 * Freehand ink on the GPU. Each stroke is tessellated once, in world space, into
 * a mesh whose vertices carry their centreline point, outward normal and half
 * width, so panning and zooming only change uniforms and the vertex shader can
 * grow a silhouette by a constant number of screen pixels for selection rings.
 */

import {
  FREEHAND_STYLE,
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
  styleWidth: number;
}

interface InkSample {
  x: number;
  y: number;
  width: number;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// One sample per world unit of control polygon, capped per segment: dense enough
// that curves stay smooth at high zoom without re-tessellating per zoom level.
function strokeSamples(stroke: FreehandStroke): InkSample[] {
  const { path, style } = stroke;
  if (!path.start) return [];
  const samples: InkSample[] = [
    { x: path.start.x, y: path.start.y, width: path.start.width ?? style.width },
  ];
  let fromX = path.start.x;
  let fromY = path.start.y;
  let fromWidth = path.start.width ?? style.width;
  for (const segment of path.segments) {
    const controlLength =
      Math.hypot(segment.cp1x - fromX, segment.cp1y - fromY) +
      Math.hypot(segment.cp2x - segment.cp1x, segment.cp2y - segment.cp1y) +
      Math.hypot(segment.x - segment.cp2x, segment.y - segment.cp2y);
    const count = Math.max(3, Math.min(32, Math.ceil(controlLength)));
    const toWidth = segment.width ?? style.width;
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      samples.push({
        x: cubic(fromX, segment.cp1x, segment.cp2x, segment.x, t),
        y: cubic(fromY, segment.cp1y, segment.cp2y, segment.y, t),
        width: fromWidth + (toWidth - fromWidth) * smoothstep(t),
      });
    }
    fromX = segment.x;
    fromY = segment.y;
    fromWidth = toWidth;
  }

  const filtered: InkSample[] = [samples[0]];
  for (let i = 1; i < samples.length - 1; i++) {
    const previous = filtered[filtered.length - 1];
    const sample = samples[i];
    if (
      Math.hypot(sample.x - previous.x, sample.y - previous.y) >= 0.1 ||
      Math.abs(sample.width - previous.width) >= 0.05
    ) {
      filtered.push(sample);
    }
  }
  const last = samples[samples.length - 1];
  const previous = filtered[filtered.length - 1];
  if (samples.length > 1 && Math.hypot(last.x - previous.x, last.y - previous.y) > 0) {
    filtered.push(last);
  }
  return filtered;
}

// Looks past near-coincident neighbours so jitter does not swing the normal.
function tangentAt(samples: readonly InkSample[], index: number): CanvasPoint | null {
  const sample = samples[index];
  let previous = samples[Math.max(0, index - 1)];
  let next = samples[Math.min(samples.length - 1, index + 1)];
  for (
    let i = index - 2;
    i >= 0 && Math.hypot(sample.x - previous.x, sample.y - previous.y) < 0.2;
    i--
  ) {
    previous = samples[i];
  }
  for (
    let i = index + 2;
    i < samples.length && Math.hypot(next.x - sample.x, next.y - sample.y) < 0.2;
    i++
  ) {
    next = samples[i];
  }
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy);
  return length === 0 ? null : { x: dx / length, y: dy / length };
}

// Interleaved per vertex: centre (2), normal (2), half width (1).
function tessellate(stroke: FreehandStroke): Float32Array {
  const samples = strokeSamples(stroke);
  const data: number[] = [];
  const vertex = (s: InkSample, nx: number, ny: number) => {
    data.push(s.x, s.y, nx, ny, s.width / 2);
  };
  // A fan of `steps` triangles sweeping from `from` towards `towards` around `s`.
  const fan = (
    s: InkSample,
    from: CanvasPoint,
    towards: CanvasPoint,
    sweep: number,
    steps: number,
  ) => {
    for (let i = 0; i < steps; i++) {
      const a = (sweep * i) / steps;
      const b = (sweep * (i + 1)) / steps;
      vertex(s, 0, 0);
      vertex(
        s,
        from.x * Math.cos(a) + towards.x * Math.sin(a),
        from.y * Math.cos(a) + towards.y * Math.sin(a),
      );
      vertex(
        s,
        from.x * Math.cos(b) + towards.x * Math.sin(b),
        from.y * Math.cos(b) + towards.y * Math.sin(b),
      );
    }
  };

  const rails: { sample: InkSample; normal: CanvasPoint; tangent: CanvasPoint }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const tangent = tangentAt(samples, i);
    if (tangent)
      rails.push({
        sample: samples[i],
        normal: { x: -tangent.y, y: tangent.x },
        tangent,
      });
  }

  if (rails.length === 0) {
    if (samples.length > 0)
      fan(samples[0], { x: 1, y: 0 }, { x: 0, y: 1 }, Math.PI * 2, 32);
    return new Float32Array(data);
  }

  for (let i = 0; i < rails.length - 1; i++) {
    const a = rails[i];
    const b = rails[i + 1];
    vertex(a.sample, a.normal.x, a.normal.y);
    vertex(a.sample, -a.normal.x, -a.normal.y);
    vertex(b.sample, b.normal.x, b.normal.y);
    vertex(a.sample, -a.normal.x, -a.normal.y);
    vertex(b.sample, -b.normal.x, -b.normal.y);
    vertex(b.sample, b.normal.x, b.normal.y);
  }
  const first = rails[0];
  const last = rails[rails.length - 1];
  fan(
    first.sample,
    first.normal,
    { x: -first.tangent.x, y: -first.tangent.y },
    Math.PI,
    16,
  );
  fan(last.sample, last.normal, last.tangent, Math.PI, 16);
  return new Float32Array(data);
}

function createMesh(gpu: CanvasGpu, styleWidth: number): InkMesh {
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
  return { vao, buffer, count: 0, styleWidth };
}

function upload(gpu: CanvasGpu, mesh: InkMesh, stroke: FreehandStroke, usage: number) {
  const data = tessellate(stroke);
  gpu.gl.bindBuffer(gpu.gl.ARRAY_BUFFER, mesh.buffer);
  gpu.gl.bufferData(gpu.gl.ARRAY_BUFFER, data, usage);
  mesh.count = data.length / 5;
  mesh.styleWidth = stroke.style.width;
}

function meshFor(gpu: CanvasGpu, stroke: FreehandStroke): InkMesh {
  const cached = gpu.resources.objects.get(stroke.path) as InkMesh | undefined;
  if (cached?.styleWidth === stroke.style.width) return cached;
  const mesh = cached ?? createMesh(gpu, stroke.style.width);
  upload(gpu, mesh, stroke, gpu.gl.STATIC_DRAW);
  gpu.resources.objects.set(stroke.path, mesh);
  return mesh;
}

// The stroke under the pen is rebuilt on every pointer move, so it streams
// through one reused buffer rather than leaving a mesh per frame behind.
function activeMesh(gpu: CanvasGpu, stroke: FreehandStroke): InkMesh {
  let mesh = gpu.resources.named.get("activeInk") as InkMesh | undefined;
  if (!mesh) {
    mesh = createMesh(gpu, stroke.style.width);
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
