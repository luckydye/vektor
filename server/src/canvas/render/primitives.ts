/**
 * Screen-space primitives every layer and extension paints with. Each is a quad
 * generated from `gl_VertexID`, its edges anti-aliased analytically rather than
 * by MSAA; rounded rects queue up and draw as one instanced call.
 */

import {
  type CanvasGpu,
  flushPending,
  type Rgba,
  setColor,
  textureFor,
  useProgram,
} from "#canvas/render/webgl.ts";
import type { CanvasPoint } from "#canvas/runtime/geometry.ts";

/**
 * A quad in CSS pixels: `origin` is the corner at uv (0,0) and the axes span to
 * uv (1,1), so rotation and skew are both expressed by the axes.
 */
export interface ScreenQuad {
  origin: CanvasPoint;
  axisX: CanvasPoint;
  axisY: CanvasPoint;
}

/** A rotated rect as a quad; `rotation` in radians about its centre. */
export function rectQuad(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
): ScreenQuad {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const cx = x + width / 2;
  const cy = y + height / 2;
  const axisX = { x: cos * width, y: sin * width };
  const axisY = { x: -sin * height, y: cos * height };
  return {
    origin: { x: cx - axisX.x / 2 - axisY.x / 2, y: cy - axisX.y / 2 - axisY.y / 2 },
    axisX,
    axisY,
  };
}

const QUAD_VERTEX = `
uniform vec2 u_origin;
uniform vec2 u_axisX;
uniform vec2 u_axisY;
// Extra CSS pixels around the quad, for anti-aliasing and outside strokes.
uniform float u_pad;
out vec2 v_local;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 size = vec2(length(u_axisX), length(u_axisY));
  vec2 local = mix(vec2(-u_pad), size + u_pad, corner);
  v_local = local;
  gl_Position = screenToClip(u_origin + normalize(u_axisX) * local.x + normalize(u_axisY) * local.y);
}
`;

function setQuad(
  gpu: CanvasGpu,
  program: ReturnType<typeof useProgram>,
  quad: ScreenQuad,
) {
  const { gl } = gpu;
  gl.uniform2f(program.uniform("u_origin"), quad.origin.x, quad.origin.y);
  gl.uniform2f(program.uniform("u_axisX"), quad.axisX.x, quad.axisX.y);
  gl.uniform2f(program.uniform("u_axisY"), quad.axisY.x, quad.axisY.y);
}

// Rounded rects are instanced: a painter draws many in a row (cards, chips,
// rules), and one call per rect spent the frame on uniform updates.
const RECT_FLOATS = 20;

const RECT_VERTEX = `
layout(location = 0) in vec2 a_origin;
layout(location = 1) in vec2 a_axisX;
layout(location = 2) in vec2 a_axisY;
layout(location = 3) in vec4 a_radius;
layout(location = 4) in vec4 a_fill;
layout(location = 5) in vec4 a_stroke;
// Stroke width, then the CSS pixels around the quad kept for anti-aliasing.
layout(location = 6) in vec2 a_stroked;
out vec2 v_local;
flat out vec2 v_size;
flat out vec4 v_radius;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out float v_strokeWidth;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 size = vec2(length(a_axisX), length(a_axisY));
  vec2 local = mix(vec2(-a_stroked.y), size + a_stroked.y, corner);
  v_local = local;
  v_size = size;
  v_radius = a_radius;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_strokeWidth = a_stroked.x;
  gl_Position = screenToClip(a_origin + normalize(a_axisX) * local.x + normalize(a_axisY) * local.y);
}
`;

const ROUNDED_RECT_FRAGMENT = `
in vec2 v_local;
flat in vec2 v_size;
// Corner radii: top-left, top-right, bottom-right, bottom-left.
flat in vec4 v_radius;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in float v_strokeWidth;
out vec4 outColor;
void main() {
  vec2 half_ = v_size * 0.5;
  vec2 p = v_local - half_;
  float r = p.x > 0.0 ? (p.y > 0.0 ? v_radius.z : v_radius.y) : (p.y > 0.0 ? v_radius.w : v_radius.x);
  vec2 q = abs(p) - half_ + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float fill = clamp(0.5 - d * u_dpr, 0.0, 1.0);
  float stroke = clamp(v_strokeWidth * u_dpr * 0.5 + 0.5 - abs(d) * u_dpr, 0.0, 1.0);
  vec4 color = v_fill * fill;
  outColor = v_stroke * stroke + color * (1.0 - v_stroke.a * stroke);
}
`;

interface RectBatch {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  data: Float32Array;
  count: number;
}

function rectBatch(gpu: CanvasGpu): RectBatch {
  const cached = gpu.resources.named.get("rectBatch") as RectBatch | undefined;
  if (cached) return cached;
  const { gl } = gpu;
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) throw new Error("Rect batch allocation failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  let offset = 0;
  [2, 2, 2, 4, 4, 4, 2].forEach((size, location) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, RECT_FLOATS * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
    offset += size;
  });
  gl.bindVertexArray(null);
  const batch = { vao, buffer, data: new Float32Array(RECT_FLOATS * 256), count: 0 };
  gpu.resources.named.set("rectBatch", batch);
  return batch;
}

function flushRects(gpu: CanvasGpu, batch: RectBatch) {
  if (batch.count === 0) return;
  const { gl } = gpu;
  useProgram(gpu, "roundedRect", RECT_VERTEX, ROUNDED_RECT_FRAGMENT);
  gl.bindVertexArray(batch.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    batch.data.subarray(0, batch.count * RECT_FLOATS),
    gl.DYNAMIC_DRAW,
  );
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  gl.bindVertexArray(null);
  batch.count = 0;
}

/** Fills and/or strokes a rounded rect; the stroke is centred on the edge. */
export function drawRoundedRect(
  gpu: CanvasGpu,
  quad: ScreenQuad,
  options: {
    /** One radius, or top-left, top-right, bottom-right, bottom-left. */
    radius?: number | readonly [number, number, number, number];
    fill?: Rgba;
    stroke?: Rgba;
    strokeWidth?: number;
    alpha?: number;
  },
) {
  const batch = rectBatch(gpu);
  if (gpu.pending?.key !== "roundedRect") {
    flushPending(gpu);
    gpu.pending = { key: "roundedRect", flush: () => flushRects(gpu, batch) };
  }
  if ((batch.count + 1) * RECT_FLOATS > batch.data.length) {
    const grown = new Float32Array(batch.data.length * 2);
    grown.set(batch.data);
    batch.data = grown;
  }
  const width = Math.hypot(quad.axisX.x, quad.axisX.y);
  const height = Math.hypot(quad.axisY.x, quad.axisY.y);
  const strokeWidth = options.stroke ? (options.strokeWidth ?? 1) : 0;
  const radius = options.radius ?? 0;
  const radii = typeof radius === "number" ? [radius, radius, radius, radius] : radius;
  const limit = Math.min(width, height) / 2;
  const premultiplied = (color: Rgba | undefined) => {
    if (!color) return [0, 0, 0, 0];
    const a = color[3] * (options.alpha ?? 1);
    return [color[0] * a, color[1] * a, color[2] * a, a];
  };
  batch.data.set(
    [
      quad.origin.x,
      quad.origin.y,
      quad.axisX.x,
      quad.axisX.y,
      quad.axisY.x,
      quad.axisY.y,
      ...radii.map((r) => Math.min(r, limit)),
      ...premultiplied(options.fill),
      ...premultiplied(options.stroke),
      strokeWidth,
      strokeWidth / 2 + 1,
    ],
    batch.count * RECT_FLOATS,
  );
  batch.count++;
}

const IMAGE_FRAGMENT = `
uniform sampler2D u_image;
uniform vec2 u_size;
uniform vec4 u_uv;
uniform float u_alpha;
in vec2 v_local;
out vec4 outColor;
void main() {
  outColor = texture(u_image, mix(u_uv.xy, u_uv.zw, v_local / u_size)) * u_alpha;
}
`;

/** The part of a texture to draw, in 0..1 texture coordinates. */
export interface TextureCrop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Draws an image or tile, uploaded and mipmapped on first use. */
export function drawImage(
  gpu: CanvasGpu,
  source: TexImageSource,
  quad: ScreenQuad,
  alpha = 1,
) {
  drawTexture(gpu, textureFor(gpu, source), quad, alpha);
}

/** Draws a premultiplied-alpha texture the caller owns, e.g. a video frame. */
export function drawTexture(
  gpu: CanvasGpu,
  texture: WebGLTexture,
  quad: ScreenQuad,
  alpha = 1,
  crop: TextureCrop = { x0: 0, y0: 0, x1: 1, y1: 1 },
) {
  const { gl } = gpu;
  const program = useProgram(gpu, "image", QUAD_VERTEX, IMAGE_FRAGMENT);
  setQuad(gpu, program, quad);
  gl.uniform1f(program.uniform("u_pad"), 0);
  gl.uniform2f(
    program.uniform("u_size"),
    Math.hypot(quad.axisX.x, quad.axisX.y),
    Math.hypot(quad.axisY.x, quad.axisY.y),
  );
  gl.uniform1f(program.uniform("u_alpha"), alpha);
  gl.uniform4f(program.uniform("u_uv"), crop.x0, crop.y0, crop.x1, crop.y1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(program.uniform("u_image"), 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

const LINE_FRAGMENT = `
uniform vec2 u_size;
uniform vec4 u_color;
uniform float u_dash;
in vec2 v_local;
out vec4 outColor;
void main() {
  float edge = clamp(u_size.y * 0.5 * u_dpr + 0.5 - abs(v_local.y - u_size.y * 0.5) * u_dpr, 0.0, 1.0);
  float on = u_dash > 0.0 ? step(mod(v_local.x, u_dash * 2.0), u_dash) : 1.0;
  outColor = u_color * edge * on;
}
`;

/** A straight line in CSS pixels, optionally dashed with equal on/off lengths. */
export function drawLine(
  gpu: CanvasGpu,
  from: CanvasPoint,
  to: CanvasPoint,
  options: { color: Rgba; width?: number; dash?: number },
) {
  const { gl } = gpu;
  const width = options.width ?? 1;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) return;
  const direction = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const program = useProgram(gpu, "line", QUAD_VERTEX, LINE_FRAGMENT);
  setQuad(gpu, program, {
    origin: {
      x: from.x + direction.y * width * 0.5,
      y: from.y - direction.x * width * 0.5,
    },
    axisX: { x: direction.x * length, y: direction.y * length },
    axisY: { x: -direction.y * width, y: direction.x * width },
  });
  gl.uniform1f(program.uniform("u_pad"), 0.5);
  gl.uniform2f(program.uniform("u_size"), length, width);
  setColor(gpu, program.uniform("u_color"), options.color);
  gl.uniform1f(program.uniform("u_dash"), options.dash ?? 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** A one-pixel dashed outline in screen px, for a box that is not a shape yet. */
export function drawDashedRect(
  gpu: CanvasGpu,
  rect: { x: number; y: number; width: number; height: number },
  color: Rgba,
) {
  const dash = 4;
  const gap = 3;
  const edge = (x: number, y: number, length: number, horizontal: boolean) => {
    for (let at = 0; at < length; at += dash + gap) {
      const size = Math.min(dash, length - at);
      const quad = horizontal
        ? rectQuad(x + at, y - 0.5, size, 1)
        : rectQuad(x - 0.5, y + at, 1, size);
      drawRoundedRect(gpu, quad, { fill: color });
    }
  };
  edge(rect.x, rect.y, rect.width, true);
  edge(rect.x, rect.y + rect.height, rect.width, true);
  edge(rect.x, rect.y, rect.height, false);
  edge(rect.x + rect.width, rect.y, rect.height, false);
}
