/**
 * Screen-space primitives every layer and extension paints with. Each is one
 * quad generated from `gl_VertexID`, so none of them owns a vertex buffer, and
 * edges are anti-aliased analytically rather than by MSAA.
 */

import {
  type CanvasGpu,
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

const ROUNDED_RECT_FRAGMENT = `
uniform vec2 u_size;
// Corner radii: top-left, top-right, bottom-right, bottom-left.
uniform vec4 u_radius;
uniform vec4 u_fill;
uniform vec4 u_stroke;
uniform float u_strokeWidth;
in vec2 v_local;
out vec4 outColor;
void main() {
  vec2 half_ = u_size * 0.5;
  vec2 p = v_local - half_;
  float r = p.x > 0.0 ? (p.y > 0.0 ? u_radius.z : u_radius.y) : (p.y > 0.0 ? u_radius.w : u_radius.x);
  vec2 q = abs(p) - half_ + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float fill = clamp(0.5 - d * u_dpr, 0.0, 1.0);
  float stroke = clamp(u_strokeWidth * u_dpr * 0.5 + 0.5 - abs(d) * u_dpr, 0.0, 1.0);
  vec4 color = u_fill * fill;
  outColor = u_stroke * stroke + color * (1.0 - u_stroke.a * stroke);
}
`;

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
  const { gl } = gpu;
  const program = useProgram(gpu, "roundedRect", QUAD_VERTEX, ROUNDED_RECT_FRAGMENT);
  const width = Math.hypot(quad.axisX.x, quad.axisX.y);
  const height = Math.hypot(quad.axisY.x, quad.axisY.y);
  const strokeWidth = options.stroke ? (options.strokeWidth ?? 1) : 0;
  setQuad(gpu, program, quad);
  gl.uniform1f(program.uniform("u_pad"), strokeWidth / 2 + 1);
  gl.uniform2f(program.uniform("u_size"), width, height);
  const radius = options.radius ?? 0;
  const radii = typeof radius === "number" ? [radius, radius, radius, radius] : radius;
  const limit = Math.min(width, height) / 2;
  gl.uniform4f(
    program.uniform("u_radius"),
    Math.min(radii[0], limit),
    Math.min(radii[1], limit),
    Math.min(radii[2], limit),
    Math.min(radii[3], limit),
  );
  setColor(gpu, program.uniform("u_fill"), options.fill ?? [0, 0, 0, 0], options.alpha);
  setColor(
    gpu,
    program.uniform("u_stroke"),
    options.stroke ?? [0, 0, 0, 0],
    options.alpha,
  );
  gl.uniform1f(program.uniform("u_strokeWidth"), strokeWidth);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
