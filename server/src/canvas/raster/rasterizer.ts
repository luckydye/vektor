/**
 * A small software rasterizer for the server: anti-aliased polygon fills by
 * exact-area coverage accumulation, glyphs from the same font outlines the
 * WebGL text uses, and PNG encoding. It lets the server draw a canvas without a
 * browser, so an agent can look at what it built.
 */

import { zlibSync } from "fflate";
import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import type { TextLayout } from "#canvas/render/textLayout.ts";
import type { FillPath } from "#canvas/render/vector.ts";
import type { Rgba } from "#canvas/render/webgl.ts";
import type { CanvasPoint } from "#canvas/runtime/geometry.ts";

/** Straight-alpha RGBA pixels. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** World → pixel: `pixel = world * scale + offset`. */
export interface RasterView {
  scale: number;
  dx: number;
  dy: number;
}

export function createRaster(width: number, height: number, background: Rgba): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = background[0] * 255;
    data[i + 1] = background[1] * 255;
    data[i + 2] = background[2] * 255;
    data[i + 3] = background[3] * 255;
  }
  return { width, height, data };
}

/**
 * Accumulates the signed area each edge covers per pixel (the font-rs method),
 * so a running sum along a row is that pixel's winding coverage.
 */
function accumulateLine(
  buffer: Float32Array,
  stride: number,
  rows: number,
  from: CanvasPoint,
  to: CanvasPoint,
) {
  if (from.y === to.y) return;
  const direction = from.y < to.y ? 1 : -1;
  const p0 = direction === 1 ? from : to;
  const p1 = direction === 1 ? to : from;
  const dxdy = (p1.x - p0.x) / (p1.y - p0.y);
  const limit = stride - 2;
  let x = p0.x;
  if (p0.y < 0) x -= p0.y * dxdy;
  const yStart = Math.max(0, Math.floor(p0.y));
  const yEnd = Math.min(rows, Math.ceil(p1.y));
  for (let y = yStart; y < yEnd; y++) {
    const row = y * stride;
    const dy = Math.min(y + 1, p1.y) - Math.max(y, p0.y);
    const xNext = x + dxdy * dy;
    const d = dy * direction;
    const x0 = Math.min(limit, Math.max(0, Math.min(x, xNext)));
    const x1 = Math.min(limit, Math.max(0, Math.max(x, xNext)));
    const x0floor = Math.floor(x0);
    const x0i = x0floor;
    const x1ceil = Math.ceil(x1);
    const x1i = x1ceil;
    if (x1i <= x0i + 1) {
      const xmf = 0.5 * (x0 + x1) - x0floor;
      buffer[row + x0i] += d - d * xmf;
      buffer[row + x0i + 1] += d * xmf;
    } else {
      const s = 1 / (x1 - x0);
      const x0f = x0 - x0floor;
      const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = x1 - x1ceil + 1;
      const am = 0.5 * s * x1f * x1f;
      buffer[row + x0i] += d * a0;
      if (x1i === x0i + 2) {
        buffer[row + x0i + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - x0f);
        buffer[row + x0i + 1] += d * (a1 - a0);
        for (let xi = x0i + 2; xi < x1i - 1; xi++) buffer[row + xi] += d * s;
        const a2 = a1 + (x1i - x0i - 3) * s;
        buffer[row + x1i - 1] += d * (1 - a2 - am);
      }
      buffer[row + x1i] += d * am;
    }
    x = xNext;
  }
}

/**
 * Coverage of overlapping convex pieces (stroke segments, joins, caps) by 4×4
 * samples per pixel: summing their soft edges darkens overlaps into beads, and
 * taking the larger leaves seams where two pieces meet mid-pixel.
 */
function unionCoverage(
  rings: readonly (readonly CanvasPoint[])[],
  left: number,
  top: number,
  width: number,
  height: number,
  into: Float32Array,
) {
  const mask = new Uint16Array(width * height);
  for (const ring of rings) {
    const xs = ring.map((point) => point.x - left);
    const ys = ring.map((point) => point.y - top);
    const area = ring.reduce((sum, point, i) => {
      const next = ring[(i + 1) % ring.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    const sign = area < 0 ? -1 : 1;
    const inside = (x: number, y: number) => {
      for (let i = 0; i < xs.length; i++) {
        const j = (i + 1) % xs.length;
        if (((xs[j] - xs[i]) * (y - ys[i]) - (ys[j] - ys[i]) * (x - xs[i])) * sign < 0) return false;
      }
      return true;
    };
    const fromY = Math.max(0, Math.floor(Math.min(...ys)));
    const toY = Math.min(height, Math.ceil(Math.max(...ys)));
    const fromX = Math.max(0, Math.floor(Math.min(...xs)));
    const toX = Math.min(width, Math.ceil(Math.max(...xs)));
    for (let y = fromY; y < toY; y++) {
      for (let x = fromX; x < toX; x++) {
        let bits = mask[y * width + x];
        if (bits === 0xffff) continue;
        for (let sample = 0; sample < 16; sample++) {
          if (bits & (1 << sample)) continue;
          if (inside(x + ((sample & 3) + 0.5) / 4, y + ((sample >> 2) + 0.5) / 4)) bits |= 1 << sample;
        }
        mask[y * width + x] = bits;
      }
    }
  }
  for (let i = 0; i < mask.length; i++) {
    let bits = mask[i];
    let count = 0;
    while (bits) {
      bits &= bits - 1;
      count++;
    }
    into[i] = count / 16;
  }
}

/** Fills rings already in pixel space. */
function fillPixelRings(
  raster: Raster,
  rings: readonly (readonly CanvasPoint[])[],
  color: Rgba,
  union: boolean,
) {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const point of ring) {
      x0 = Math.min(x0, point.x);
      y0 = Math.min(y0, point.y);
      x1 = Math.max(x1, point.x);
      y1 = Math.max(y1, point.y);
    }
  }
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(raster.width, Math.ceil(x1) + 1);
  const bottom = Math.min(raster.height, Math.ceil(y1) + 1);
  if (right <= left || bottom <= top) return;
  const width = right - left;
  const height = bottom - top;
  const stride = width + 2;
  const buffer = new Float32Array(stride * height);
  const accumulate = (ring: readonly CanvasPoint[]) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      accumulateLine(buffer, stride, height, { x: a.x - left, y: a.y - top }, { x: b.x - left, y: b.y - top });
    }
  };
  // Winding coverage of what is in `buffer` over local columns `from`..`to` and
  // rows `top`..`end`, summed along each row and cleared for the next piece.
  const resolve = (
    into: Float32Array,
    merge: (old: number, next: number) => number,
    rows: [number, number] = [0, height],
    columns: [number, number] = [0, width],
  ) => {
    for (let y = Math.max(0, rows[0]); y < Math.min(height, rows[1]); y++) {
      let sum = 0;
      const row = y * stride;
      for (let x = Math.max(0, columns[0]); x < Math.min(width, columns[1]); x++) {
        sum += buffer[row + x];
        buffer[row + x] = 0;
        into[y * width + x] = merge(into[y * width + x], Math.min(1, Math.abs(sum)));
      }
      for (let x = Math.min(width, columns[1]); x < Math.min(stride, columns[1] + 2); x++) buffer[row + x] = 0;
    }
  };
  const coverage = new Float32Array(width * height);
  if (union) unionCoverage(rings, left, top, width, height, coverage);
  else {
    for (const ring of rings) accumulate(ring);
    resolve(coverage, (_old, next) => next);
  }
  const { data } = raster;
  const alpha = color[3];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = coverage[y * width + x] * alpha;
      if (value <= 0.002) continue;
      const index = ((top + y) * raster.width + left + x) * 4;
      const under = data[index + 3] / 255;
      const outA = value + under * (1 - value);
      for (let c = 0; c < 3; c++) {
        data[index + c] = (color[c] * 255 * value + data[index + c] * under * (1 - value)) / outA;
      }
      data[index + 3] = outA * 255;
    }
  }
}

export function fillWorldPath(raster: Raster, view: RasterView, path: FillPath, color: Rgba) {
  const rings = path.rings
    .filter((ring) => ring.length >= 3)
    .map((ring) =>
      ring.map((point) => ({ x: point.x * view.scale + view.dx, y: point.y * view.scale + view.dy })),
    );
  if (rings.length > 0 && color[3] > 0) fillPixelRings(raster, rings, color, path.rule === "union");
}

/** Where a text layout lands: its (0, 0) at `origin` px, `scale` px per unit, rotated by `rotation` radians. */
export interface RasterTextPlacement {
  origin: CanvasPoint;
  scale: number;
  rotation: number;
}

export function drawRasterText(
  raster: Raster,
  layout: TextLayout,
  fonts: ReadonlyMap<FontFace, Font>,
  placement: RasterTextPlacement,
) {
  const cos = Math.cos(placement.rotation) * placement.scale;
  const sin = Math.sin(placement.rotation) * placement.scale;
  const map = (x: number, y: number) => ({
    x: placement.origin.x + x * cos - y * sin,
    y: placement.origin.y + x * sin + y * cos,
  });
  for (const rect of layout.rects) {
    const corners = [
      map(rect.x, rect.y),
      map(rect.x + rect.width, rect.y),
      map(rect.x + rect.width, rect.y + rect.height),
      map(rect.x, rect.y + rect.height),
    ];
    if (rect.fill) fillPixelRings(raster, [corners], rect.fill, false);
  }
  for (const glyph of layout.glyphs) {
    const font = fonts.get(glyph.face);
    if (!font) throw new Error(`Font ${glyph.face} is not loaded`);
    const { curves } = font.glyph(glyph.index);
    if (curves.length === 0) continue;
    // Contours as polylines; each quadratic flattened into a few segments.
    const rings: CanvasPoint[][] = [];
    let ring: CanvasPoint[] = [];
    let last: { x: number; y: number } | null = null;
    const steps = glyph.size * placement.scale > 24 ? 6 : 3;
    for (let i = 0; i < curves.length; i += 6) {
      const [ax, ay, bx, by, cx, cy] = curves.subarray(i, i + 6);
      if (!last || Math.abs(last.x - ax) > 1e-5 || Math.abs(last.y - ay) > 1e-5) {
        if (ring.length > 2) rings.push(ring);
        ring = [];
      }
      for (let s = ring.length === 0 ? 0 : 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        const ex = u * u * ax + 2 * u * t * bx + t * t * cx;
        const ey = u * u * ay + 2 * u * t * by + t * t * cy;
        ring.push(map(glyph.x + ex * glyph.size, glyph.y - ey * glyph.size));
      }
      last = { x: cx, y: cy };
    }
    if (ring.length > 2) rings.push(ring);
    fillPixelRings(raster, rings, glyph.color, false);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePng(raster: Raster): Uint8Array {
  const { width, height, data } = raster;
  const scanlines = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(body.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(scanlines, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
