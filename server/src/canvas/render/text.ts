/**
 * Text drawn straight from glyph outlines with Eric Lengyel's Slug algorithm:
 * each fragment casts a horizontal and a vertical ray through the glyph's
 * quadratic curves and turns the crossings into coverage, so labels stay sharp
 * at every zoom with no atlas. Curves are looped per glyph rather than banded,
 * which suits short labels.
 */

import { type Font, parseFont } from "#canvas/render/font.ts";
import { type CanvasGpu, type Rgba, setColor, useProgram } from "#canvas/render/webgl.ts";
import type { CanvasPoint } from "#canvas/runtime/geometry.ts";

const CURVE_TEXTURE_WIDTH = 4096;

let font: Font | null = null;
let fontLoad: Promise<void> | null = null;
const waiting = new Set<() => void>();

// The font arrives asynchronously the first time any text is drawn; callers
// asking before then are repainted once it lands.
function loadedFont(invalidate: () => void): Font | null {
  if (font) return font;
  waiting.add(invalidate);
  fontLoad ??= import("#assets/fonts/Inter-Bold.ttf?url")
    .then((module) => fetch(module.default))
    .then((response) => {
      if (!response.ok) throw new Error(`Canvas font failed to load: ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      font = parseFont(buffer);
      for (const repaint of waiting) repaint();
      waiting.clear();
    });
  return null;
}

/** Glyph curves packed two texels per curve, uploaded as new glyphs are used. */
interface CurveStore {
  texture: WebGLTexture;
  data: Float32Array;
  used: number;
  dirty: boolean;
  glyphs: Map<number, { start: number; count: number }>;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
}

function curveStore(gpu: CanvasGpu): CurveStore {
  const cached = gpu.resources.named.get("textCurves") as CurveStore | undefined;
  if (cached) return cached;
  const { gl } = gpu;
  const texture = gl.createTexture();
  const vao = gl.createVertexArray();
  const instances = gl.createBuffer();
  if (!texture || !vao || !instances) throw new Error("Text resource allocation failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
  gl.vertexAttribDivisor(1, 1);
  gl.bindVertexArray(null);
  const store: CurveStore = {
    texture,
    data: new Float32Array(CURVE_TEXTURE_WIDTH * 4 * 4),
    used: 0,
    dirty: true,
    glyphs: new Map(),
    vao,
    instances,
  };
  gpu.resources.named.set("textCurves", store);
  return store;
}

function glyphCurves(store: CurveStore, codePoint: number, curves: Float32Array) {
  const cached = store.glyphs.get(codePoint);
  if (cached) return cached;
  const count = curves.length / 6;
  const needed = (store.used + count * 2) * 4;
  if (needed > store.data.length) {
    const rows = Math.ceil(needed / (CURVE_TEXTURE_WIDTH * 4));
    const grown = new Float32Array(rows * CURVE_TEXTURE_WIDTH * 4 * 2);
    grown.set(store.data);
    store.data = grown;
  }
  for (let i = 0; i < count; i++) {
    const texel = (store.used + i * 2) * 4;
    store.data.set(curves.subarray(i * 6, i * 6 + 4), texel);
    store.data.set(curves.subarray(i * 6 + 4, i * 6 + 6), texel + 4);
  }
  const entry = { start: store.used, count };
  store.used += count * 2;
  store.dirty = true;
  store.glyphs.set(codePoint, entry);
  return entry;
}

const TEXT_VERTEX = `
layout(location = 0) in vec4 a_bounds;
layout(location = 1) in vec3 a_glyph;
uniform vec2 u_origin;
uniform vec2 u_direction;
uniform vec2 u_scale;
out vec2 v_em;
out vec2 v_local;
flat out vec2 v_curves;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 pad = vec2(1.0) / (u_scale * u_dpr);
  vec2 em = mix(a_bounds.xy - pad, a_bounds.zw + pad, corner);
  vec2 local = vec2(em.x * u_scale.x, -em.y * u_scale.y);
  v_em = em - vec2(a_glyph.x, 0.0);
  v_local = local;
  v_curves = a_glyph.yz;
  vec2 normal = vec2(-u_direction.y, u_direction.x);
  gl_Position = screenToClip(u_origin + u_direction * local.x + normal * local.y);
}
`;

const TEXT_FRAGMENT = `
uniform highp sampler2D u_curves;
uniform vec4 u_color;
uniform vec4 u_clip;
in vec2 v_em;
in vec2 v_local;
flat in vec2 v_curves;
out vec4 outColor;

vec4 curveTexel(int index) {
  return texelFetch(u_curves, ivec2(index % ${CURVE_TEXTURE_WIDTH}, index / ${CURVE_TEXTURE_WIDTH}), 0);
}

// Which of the curve's two roots cross the ray, from the signs of its three y
// values: bit 0 for the first root, bit 8 for the second.
uint rootCode(float y1, float y2, float y3) {
  uint i1 = floatBitsToUint(y1) >> 31u;
  uint i2 = floatBitsToUint(y2) >> 30u;
  uint i3 = floatBitsToUint(y3) >> 29u;
  uint shift = (i2 & 2u) | (i1 & ~2u);
  shift = (i3 & 4u) | (shift & ~4u);
  return (0x2E74u >> shift) & 0x0101u;
}

vec2 solveHorizontal(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  float t1 = (b.y - d) / a.y;
  float t2 = (b.y + d) / a.y;
  if (abs(a.y) < 1.0 / 65536.0) { t1 = p12.y * 0.5 / b.y; t2 = t1; }
  return vec2((a.x * t1 - b.x * 2.0) * t1 + p12.x, (a.x * t2 - b.x * 2.0) * t2 + p12.x);
}

vec2 solveVertical(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  float t1 = (b.x - d) / a.x;
  float t2 = (b.x + d) / a.x;
  if (abs(a.x) < 1.0 / 65536.0) { t1 = p12.x * 0.5 / b.x; t2 = t1; }
  return vec2((a.y * t1 - b.y * 2.0) * t1 + p12.y, (a.y * t2 - b.y * 2.0) * t2 + p12.y);
}

void main() {
  if (v_local.x < u_clip.x || v_local.y < u_clip.y || v_local.x > u_clip.z || v_local.y > u_clip.w) discard;
  vec2 pixelsPerEm = 1.0 / fwidth(v_em);
  float xcov = 0.0;
  float xwgt = 0.0;
  float ycov = 0.0;
  float ywgt = 0.0;
  int start = int(v_curves.x);
  int count = int(v_curves.y);
  for (int i = 0; i < count; i++) {
    vec4 p12 = curveTexel(start + i * 2) - vec4(v_em, v_em);
    vec2 p3 = curveTexel(start + i * 2 + 1).xy - v_em;

    uint code = rootCode(p12.y, p12.w, p3.y);
    if (code != 0u) {
      vec2 r = solveHorizontal(p12, p3) * pixelsPerEm.x;
      if ((code & 1u) != 0u) {
        xcov += clamp(r.x + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(r.x) * 2.0, 0.0, 1.0));
      }
      if (code > 1u) {
        xcov -= clamp(r.y + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(r.y) * 2.0, 0.0, 1.0));
      }
    }

    code = rootCode(p12.x, p12.z, p3.x);
    if (code != 0u) {
      vec2 r = solveVertical(p12, p3) * pixelsPerEm.y;
      if ((code & 1u) != 0u) {
        ycov -= clamp(r.x + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(r.x) * 2.0, 0.0, 1.0));
      }
      if (code > 1u) {
        ycov += clamp(r.y + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(r.y) * 2.0, 0.0, 1.0));
      }
    }
  }
  float coverage = max(
    abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0),
    min(abs(xcov), abs(ycov))
  );
  outColor = u_color * clamp(coverage, 0.0, 1.0);
}
`;

export interface TextOptions {
  /** Screen position of the text's left edge on its middle line. */
  at: CanvasPoint;
  /** Radians, about `at`. */
  rotation?: number;
  size: number;
  color: Rgba;
  /** Squeezes the text horizontally to fit, like `fillText`'s `maxWidth`. */
  maxWidth?: number;
  /** Rect in the text's own unrotated pixels, relative to `at`. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Repaints once the font has loaded; text is skipped until then. */
  invalidate: () => void;
}

export function drawText(gpu: CanvasGpu, text: string, options: TextOptions) {
  const loaded = loadedFont(options.invalidate);
  if (!loaded || text.length === 0) return;
  const { gl } = gpu;
  const store = curveStore(gpu);

  const instances: number[] = [];
  let pen = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const glyph = loaded.glyph(codePoint);
    if (glyph.curves.length > 0) {
      const curves = glyphCurves(store, codePoint, glyph.curves);
      const { x0, y0, x1, y1 } = glyph.bounds;
      instances.push(pen + x0, y0, pen + x1, y1, pen, curves.start, curves.count);
    }
    pen += glyph.advance;
  }
  if (instances.length === 0) return;

  if (store.dirty) {
    gl.bindTexture(gl.TEXTURE_2D, store.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      CURVE_TEXTURE_WIDTH,
      store.data.length / (CURVE_TEXTURE_WIDTH * 4),
      0,
      gl.RGBA,
      gl.FLOAT,
      store.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    store.dirty = false;
  }

  const width = pen * options.size;
  const squeeze =
    options.maxWidth !== undefined && width > options.maxWidth
      ? Math.max(0, options.maxWidth) / width
      : 1;
  // Shift from the middle line to the baseline, in em.
  const middle = (loaded.ascender + loaded.descender) / 2;
  const rotation = options.rotation ?? 0;
  const direction = { x: Math.cos(rotation), y: Math.sin(rotation) };
  const clip = options.clip ?? { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };

  const program = useProgram(gpu, "text", TEXT_VERTEX, TEXT_FRAGMENT);
  gl.uniform2f(
    program.uniform("u_origin"),
    options.at.x - direction.y * middle * options.size,
    options.at.y + direction.x * middle * options.size,
  );
  gl.uniform2f(program.uniform("u_direction"), direction.x, direction.y);
  gl.uniform2f(program.uniform("u_scale"), options.size * squeeze, options.size);
  // The clip is relative to `at`, the varying to the baseline origin.
  gl.uniform4f(
    program.uniform("u_clip"),
    clip.x,
    clip.y - middle * options.size,
    clip.x + clip.width,
    clip.y + clip.height - middle * options.size,
  );
  setColor(gpu, program.uniform("u_color"), options.color);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, store.texture);
  gl.uniform1i(program.uniform("u_curves"), 0);
  gl.bindVertexArray(store.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, store.instances);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.DYNAMIC_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.length / 7);
  gl.bindVertexArray(null);
}
