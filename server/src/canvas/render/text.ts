/**
 * Painted text: a `TextLayout` placed on screen. Glyphs are drawn straight from
 * their outlines with Eric Lengyel's Slug algorithm — each fragment casts a
 * horizontal and a vertical ray through the glyph's quadratic curves — so text
 * stays sharp at every zoom with no atlas. One instanced draw per font face.
 */

import type { FontFace } from "#canvas/render/fonts.ts";
import { fontFaces } from "#canvas/render/fonts.ts";
import { remembered } from "#canvas/render/lru.ts";
import {
  drawRoundedRect,
  drawTexture,
  type ScreenQuad,
} from "#canvas/render/primitives.ts";
import {
  type LaidRect,
  layoutText,
  type TextLayout,
  type TextStyle,
} from "#canvas/render/textLayout.ts";
import { type CanvasGpu, textureFor, useProgram } from "#canvas/render/webgl.ts";
import type { CanvasPoint } from "#canvas/runtime/geometry.ts";

const CURVE_TEXTURE_WIDTH = 4096;
// Floats per glyph instance: em bounds (4), origin and size (3), curves (2), colour (4).
const INSTANCE_FLOATS = 13;

/**
 * Where a layout lands on screen: its (0, 0) at `origin`, `scale` screen pixels
 * per layout unit, rotated by `rotation` radians.
 */
export interface TextPlacement {
  origin: CanvasPoint;
  scale: number;
  rotation: number;
  /** Visible part of the layout, in layout units. */
  clip?: { x: number; y: number; width: number; height: number };
}

/** Glyph curves packed two texels per curve, uploaded as new glyphs are used. */
interface CurveStore {
  texture: WebGLTexture;
  data: Float32Array;
  used: number;
  dirty: boolean;
  glyphs: Map<string, { start: number; count: number }>;
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
  const stride = INSTANCE_FLOATS * 4;
  const attributes = [4, 3, 2, 4];
  let offset = 0;
  attributes.forEach((size, location) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
    gl.vertexAttribDivisor(location, 1);
    offset += size;
  });
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

function glyphCurves(store: CurveStore, key: string, curves: Float32Array) {
  const cached = store.glyphs.get(key);
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
  store.glyphs.set(key, entry);
  return entry;
}

const TEXT_VERTEX = `
layout(location = 0) in vec4 a_bounds;
layout(location = 1) in vec3 a_place;
layout(location = 2) in vec2 a_curves;
layout(location = 3) in vec4 a_color;
uniform vec2 u_origin;
uniform vec2 u_axisX;
uniform vec2 u_axisY;
uniform float u_scale;
out vec2 v_em;
out vec2 v_layout;
flat out vec2 v_curves;
flat out vec4 v_color;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  float pad = 1.0 / (a_place.z * u_scale * u_dpr);
  vec2 em = mix(a_bounds.xy - pad, a_bounds.zw + pad, corner);
  vec2 layoutPoint = a_place.xy + vec2(em.x, -em.y) * a_place.z;
  v_em = em;
  v_layout = layoutPoint;
  v_curves = a_curves;
  v_color = a_color;
  gl_Position = screenToClip(u_origin + u_axisX * layoutPoint.x + u_axisY * layoutPoint.y);
}
`;

const TEXT_FRAGMENT = `
uniform highp sampler2D u_curves;
uniform vec4 u_clip;
in vec2 v_em;
in vec2 v_layout;
flat in vec2 v_curves;
flat in vec4 v_color;
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
  if (v_layout.x < u_clip.x || v_layout.y < u_clip.y || v_layout.x > u_clip.z || v_layout.y > u_clip.w) discard;
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
  outColor = v_color * clamp(coverage, 0.0, 1.0);
}
`;

function axes(placement: TextPlacement) {
  const cos = Math.cos(placement.rotation) * placement.scale;
  const sin = Math.sin(placement.rotation) * placement.scale;
  return { axisX: { x: cos, y: sin }, axisY: { x: -sin, y: cos } };
}

function quadOf(
  placement: TextPlacement,
  rect: { x: number; y: number; width: number; height: number },
): ScreenQuad {
  const { axisX, axisY } = axes(placement);
  return {
    origin: {
      x: placement.origin.x + axisX.x * rect.x + axisY.x * rect.y,
      y: placement.origin.y + axisX.y * rect.x + axisY.y * rect.y,
    },
    axisX: { x: axisX.x * rect.width, y: axisX.y * rect.width },
    axisY: { x: axisY.x * rect.height, y: axisY.y * rect.height },
  };
}

function clipRect(rect: LaidRect, clip: TextPlacement["clip"]): LaidRect | null {
  if (!clip) return rect;
  const x0 = Math.max(rect.x, clip.x);
  const y0 = Math.max(rect.y, clip.y);
  const x1 = Math.min(rect.x + rect.width, clip.x + clip.width);
  const y1 = Math.min(rect.y + rect.height, clip.y + clip.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { ...rect, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Draws a laid-out block of text. `image` resolves the layout's images to
 * loaded sources, or null while they load.
 */
export function drawTextLayout(
  gpu: CanvasGpu,
  layout: TextLayout,
  placement: TextPlacement,
  image: (src: string) => TexImageSource | null = () => null,
) {
  const { gl } = gpu;
  for (const laid of layout.rects) {
    const rect = clipRect(laid, placement.clip);
    if (!rect) continue;
    drawRoundedRect(gpu, quadOf(placement, rect), {
      radius: rect.radius * placement.scale,
      fill: rect.fill,
      stroke: rect.stroke,
      strokeWidth: (rect.strokeWidth ?? 1) * placement.scale,
    });
  }
  for (const laid of layout.images) {
    const source = image(laid.src);
    const rect = clipRect({ ...laid, radius: 0 }, placement.clip);
    if (!source || !rect || laid.height <= 0) continue;
    drawTexture(gpu, textureFor(gpu, source), quadOf(placement, rect), 1, {
      x0: (rect.x - laid.x) / laid.width,
      y0: (rect.y - laid.y) / laid.height,
      x1: (rect.x + rect.width - laid.x) / laid.width,
      y1: (rect.y + rect.height - laid.y) / laid.height,
    });
  }
  if (layout.glyphs.length === 0) return;

  const faces = new Set(layout.glyphs.map((glyph) => glyph.face));
  const fonts = fontFaces(faces, () => {});
  if (!fonts) throw new Error("Text is laid out before its fonts have loaded");
  const store = curveStore(gpu);
  const byFace = new Map<FontFace, number[]>();
  for (const glyph of layout.glyphs) {
    const font = fonts.get(glyph.face);
    if (!font) throw new Error(`Font ${glyph.face} is not loaded`);
    const outline = font.glyph(glyph.index);
    if (outline.curves.length === 0) continue;
    const curves = glyphCurves(store, `${glyph.face}:${glyph.index}`, outline.curves);
    const { x0, y0, x1, y1 } = outline.bounds;
    const alpha = glyph.color[3];
    const list = byFace.get(glyph.face) ?? [];
    byFace.set(glyph.face, list);
    list.push(
      x0,
      y0,
      x1,
      y1,
      glyph.x,
      glyph.y,
      glyph.size,
      curves.start,
      curves.count,
      glyph.color[0] * alpha,
      glyph.color[1] * alpha,
      glyph.color[2] * alpha,
      alpha,
    );
  }

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

  const program = useProgram(gpu, "text", TEXT_VERTEX, TEXT_FRAGMENT);
  const { axisX, axisY } = axes(placement);
  const clip = placement.clip ?? { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };
  gl.uniform2f(program.uniform("u_origin"), placement.origin.x, placement.origin.y);
  gl.uniform2f(program.uniform("u_axisX"), axisX.x, axisX.y);
  gl.uniform2f(program.uniform("u_axisY"), axisY.x, axisY.y);
  gl.uniform1f(program.uniform("u_scale"), placement.scale);
  gl.uniform4f(
    program.uniform("u_clip"),
    clip.x,
    clip.y,
    clip.x + clip.width,
    clip.y + clip.height,
  );
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, store.texture);
  gl.uniform1i(program.uniform("u_curves"), 0);
  gl.bindVertexArray(store.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, store.instances);
  for (const instances of byFace.values()) {
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.length / INSTANCE_FLOATS);
  }
  gl.bindVertexArray(null);
}

const singleLines = new Map<string, TextLayout>();

/**
 * One line of text in one style, e.g. a label. Returns its layout, or null
 * until the font has loaded; `invalidate` repaints once it has.
 */
export function lineLayout(
  text: string,
  style: TextStyle,
  invalidate: () => void,
  maxWidth = Number.POSITIVE_INFINITY,
): TextLayout | null {
  const key = `${style.face}|${style.size}|${style.color}|${maxWidth}|${text}`;
  const cached = singleLines.get(key);
  if (cached) return remembered(singleLines, key, 4096, () => cached);
  const fonts = fontFaces([style.face], invalidate);
  if (!fonts) return null;
  return remembered(singleLines, key, 4096, () =>
    layoutText(
      [
        {
          kind: "text",
          runs: [{ text, style }],
          spacing: { marginTop: 0, marginBottom: 0, indent: 0, lineHeight: 1.2 },
        },
      ],
      fonts,
      { width: maxWidth, imageAspect: () => null },
    ),
  );
}

/** Placement that puts a layout's middle line at `at`, like `textBaseline = "middle"`. */
export function middlePlacement(
  layout: TextLayout,
  at: CanvasPoint,
  scale: number,
  rotation = 0,
): TextPlacement {
  const up = layout.height / 2;
  return {
    origin: {
      x: at.x + Math.sin(rotation) * up * scale,
      y: at.y - Math.cos(rotation) * up * scale,
    },
    scale,
    rotation,
  };
}
