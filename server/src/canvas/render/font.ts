/**
 * A minimal TrueType reader: `cmap`, `hmtx` and `glyf` for outlines, and the
 * `GPOS` kern pairs. Expects the bundled fonts, whose composite glyphs were
 * flattened when they were subset.
 */

export interface FontGlyph {
  /** Advance and bounds in ems, y up. */
  advance: number;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Quadratic curves in ems, six floats each: p0, p1 (control), p2. */
  curves: Float32Array;
}

/** Metrics in ems; `descender` is negative. */
export interface Font {
  ascender: number;
  descender: number;
  glyphIndex: (codePoint: number) => number;
  glyph: (index: number) => FontGlyph;
  /** Advance adjustment between two glyph indices, in ems. */
  kerning: (left: number, right: number) => number;
}

function tables(view: DataView) {
  const count = view.getUint16(4);
  const offsets = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    offsets.set(tag, view.getUint32(record + 8));
  }
  return (tag: string) => {
    const offset = offsets.get(tag);
    if (offset === undefined) throw new Error(`Font has no ${tag} table`);
    return offset;
  };
}

// Format 4 (BMP) segment lookup from the Windows Unicode subtable.
function readCmap(view: DataView, cmap: number): (codePoint: number) => number {
  const count = view.getUint16(cmap + 2);
  let subtable = -1;
  for (let i = 0; i < count; i++) {
    const record = cmap + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    if ((platform === 3 && encoding === 1) || platform === 0) {
      if (view.getUint16(offset) === 4) subtable = offset;
    }
  }
  if (subtable < 0) throw new Error("Font has no format 4 Unicode cmap");
  const segments = view.getUint16(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (codePoint) => {
    for (let i = 0; i < segments; i++) {
      if (codePoint > view.getUint16(ends + i * 2)) continue;
      const start = view.getUint16(starts + i * 2);
      if (codePoint < start) return 0;
      const delta = view.getInt16(deltas + i * 2);
      const rangeOffset = view.getUint16(rangeOffsets + i * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyph = view.getUint16(
        rangeOffsets + i * 2 + rangeOffset + (codePoint - start) * 2,
      );
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

// TrueType contours alternate on- and off-curve points; two off-curve points in
// a row imply an on-curve point midway, and a line is a curve whose control is
// its midpoint.
function contourCurves(xs: number[], ys: number[], on: boolean[], out: number[]) {
  const n = xs.length;
  const firstOn = on.indexOf(true);
  const startX = firstOn >= 0 ? xs[firstOn] : (xs[0] + xs[1]) / 2;
  const startY = firstOn >= 0 ? ys[firstOn] : (ys[0] + ys[1]) / 2;
  const begin = firstOn >= 0 ? firstOn : 0;
  let x = startX;
  let y = startY;
  let control: { x: number; y: number } | null = null;
  const curve = (cx: number, cy: number, ex: number, ey: number) => {
    out.push(x, y, cx, cy, ex, ey);
    x = ex;
    y = ey;
  };
  for (let step = 1; step <= n; step++) {
    const i = (begin + step) % n;
    const closing = step === n && firstOn >= 0;
    const px = closing ? startX : xs[i];
    const py = closing ? startY : ys[i];
    if (on[i] || closing) {
      if (control) curve(control.x, control.y, px, py);
      else curve((x + px) / 2, (y + py) / 2, px, py);
      control = null;
    } else if (control) {
      const mx = (control.x + px) / 2;
      const my = (control.y + py) / 2;
      curve(control.x, control.y, mx, my);
      control = { x: px, y: py };
    } else {
      control = { x: px, y: py };
    }
  }
  if (control) curve(control.x, control.y, startX, startY);
}

export function parseFont(buffer: ArrayBuffer): Font {
  const view = new DataView(buffer);
  const table = tables(view);
  const head = table("head");
  const hhea = table("hhea");
  const unitsPerEm = view.getUint16(head + 18);
  const longLoca = view.getInt16(head + 50) === 1;
  const metricCount = view.getUint16(hhea + 34);
  const glyphCount = view.getUint16(table("maxp") + 4);
  const hmtx = table("hmtx");
  const loca = table("loca");
  const glyf = table("glyf");
  const glyphIndex = readCmap(view, table("cmap"));
  const em = (value: number) => value / unitsPerEm;
  const cache = new Map<number, FontGlyph>();

  const locate = (index: number) =>
    longLoca ? view.getUint32(loca + index * 4) : view.getUint16(loca + index * 2) * 2;

  const readGlyph = (index: number): FontGlyph => {
    if (index >= glyphCount) throw new Error(`Glyph ${index} out of range`);
    const advance = em(view.getUint16(hmtx + Math.min(index, metricCount - 1) * 4));
    const start = glyf + locate(index);
    const empty = locate(index + 1) === locate(index);
    if (empty) {
      return {
        advance,
        bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
        curves: new Float32Array(),
      };
    }
    const contours = view.getInt16(start);
    if (contours < 0)
      throw new Error("Composite glyphs must be flattened when subsetting");
    const bounds = {
      x0: em(view.getInt16(start + 2)),
      y0: em(view.getInt16(start + 4)),
      x1: em(view.getInt16(start + 6)),
      y1: em(view.getInt16(start + 8)),
    };
    const endPoints: number[] = [];
    for (let i = 0; i < contours; i++) endPoints.push(view.getUint16(start + 10 + i * 2));
    const pointCount = contours === 0 ? 0 : endPoints[contours - 1] + 1;
    let cursor = start + 10 + contours * 2;
    cursor += 2 + view.getUint16(cursor);

    const flags: number[] = [];
    while (flags.length < pointCount) {
      const flag = view.getUint8(cursor++);
      flags.push(flag);
      if (flag & 8) {
        const repeat = view.getUint8(cursor++);
        for (let i = 0; i < repeat; i++) flags.push(flag);
      }
    }
    const coordinates = (short: number, same: number) => {
      const values: number[] = [];
      let value = 0;
      for (const flag of flags) {
        if (flag & short) {
          const delta = view.getUint8(cursor++);
          value += flag & same ? delta : -delta;
        } else if (!(flag & same)) {
          value += view.getInt16(cursor);
          cursor += 2;
        }
        values.push(em(value));
      }
      return values;
    };
    const xs = coordinates(2, 16);
    const ys = coordinates(4, 32);

    const curves: number[] = [];
    let first = 0;
    for (const last of endPoints) {
      const on = flags.slice(first, last + 1).map((flag) => (flag & 1) === 1);
      if (on.length > 1)
        contourCurves(xs.slice(first, last + 1), ys.slice(first, last + 1), on, curves);
      first = last + 1;
    }
    return { advance, bounds, curves: new Float32Array(curves) };
  };

  const pairAdjustment = readKernPairs(view, table("GPOS"));
  const kerningCache = new Map<number, number>();

  return {
    ascender: em(view.getInt16(hhea + 4)),
    descender: em(view.getInt16(hhea + 6)),
    glyphIndex,
    glyph: (index) => {
      let glyph = cache.get(index);
      if (!glyph) {
        glyph = readGlyph(index);
        cache.set(index, glyph);
      }
      return glyph;
    },
    kerning: (left, right) => {
      const key = left * 65536 + right;
      let value = kerningCache.get(key);
      if (value === undefined) {
        value = em(pairAdjustment(left, right));
        kerningCache.set(key, value);
      }
      return value;
    },
  };
}

function coverageIndex(view: DataView, offset: number, glyph: number): number {
  const format = view.getUint16(offset);
  const count = view.getUint16(offset + 2);
  if (format === 1) {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const value = view.getUint16(offset + 4 + middle * 2);
      if (value === glyph) return middle;
      if (value < glyph) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }
  for (let i = 0; i < count; i++) {
    const range = offset + 4 + i * 6;
    const start = view.getUint16(range);
    if (glyph >= start && glyph <= view.getUint16(range + 2)) {
      return view.getUint16(range + 4) + glyph - start;
    }
  }
  return -1;
}

function glyphClass(view: DataView, offset: number, glyph: number): number {
  const format = view.getUint16(offset);
  if (format === 1) {
    const start = view.getUint16(offset + 2);
    const count = view.getUint16(offset + 4);
    const index = glyph - start;
    return index >= 0 && index < count ? view.getUint16(offset + 6 + index * 2) : 0;
  }
  const count = view.getUint16(offset + 2);
  for (let i = 0; i < count; i++) {
    const range = offset + 4 + i * 6;
    if (glyph >= view.getUint16(range) && glyph <= view.getUint16(range + 2)) {
      return view.getUint16(range + 4);
    }
  }
  return 0;
}

function valueRecordSize(format: number): number {
  let size = 0;
  for (let bit = format; bit; bit >>= 1) size += (bit & 1) * 2;
  return size;
}

// Byte offset of XAdvance inside a value record: after XPlacement and YPlacement.
function xAdvanceOffset(format: number): number | null {
  if (!(format & 4)) return null;
  return ((format & 1) + ((format >> 1) & 1)) * 2;
}

// The `kern` feature's pair-adjustment subtables (lookup type 2, or 9 wrapping
// it), as one lookup from a glyph pair to an XAdvance in font units.
function readKernPairs(view: DataView, gpos: number) {
  const features = gpos + view.getUint16(gpos + 6);
  const lookups = gpos + view.getUint16(gpos + 8);
  const lookupIndices = new Set<number>();
  for (let i = 0; i < view.getUint16(features); i++) {
    const record = features + 2 + i * 6;
    const tag = String.fromCharCode(
      ...[0, 1, 2, 3].map((byte) => view.getUint8(record + byte)),
    );
    if (tag !== "kern") continue;
    const feature = features + view.getUint16(record + 4);
    for (let j = 0; j < view.getUint16(feature + 2); j++) {
      lookupIndices.add(view.getUint16(feature + 4 + j * 2));
    }
  }
  const subtables: number[] = [];
  for (const index of [...lookupIndices].sort((a, b) => a - b)) {
    const lookup = lookups + view.getUint16(lookups + 2 + index * 2);
    const type = view.getUint16(lookup);
    for (let j = 0; j < view.getUint16(lookup + 4); j++) {
      let subtable = lookup + view.getUint16(lookup + 6 + j * 2);
      if (type === 9) {
        if (view.getUint16(subtable + 2) !== 2) continue;
        subtable += view.getUint32(subtable + 4);
      } else if (type !== 2) {
        continue;
      }
      subtables.push(subtable);
    }
  }

  return (left: number, right: number): number => {
    for (const subtable of subtables) {
      const covered = coverageIndex(view, subtable + view.getUint16(subtable + 2), left);
      if (covered < 0) continue;
      const format1 = view.getUint16(subtable + 4);
      const format2 = view.getUint16(subtable + 6);
      const advance = xAdvanceOffset(format1);
      const recordSize = valueRecordSize(format1) + valueRecordSize(format2);
      if (view.getUint16(subtable) === 1) {
        const set = subtable + view.getUint16(subtable + 10 + covered * 2);
        let low = 0;
        let high = view.getUint16(set) - 1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const record = set + 2 + middle * (2 + recordSize);
          const second = view.getUint16(record);
          if (second === right) {
            return advance === null ? 0 : view.getInt16(record + 2 + advance);
          }
          if (second < right) low = middle + 1;
          else high = middle - 1;
        }
        continue;
      }
      const class1 = glyphClass(view, subtable + view.getUint16(subtable + 8), left);
      const class2 = glyphClass(view, subtable + view.getUint16(subtable + 10), right);
      const class2Count = view.getUint16(subtable + 14);
      const record = subtable + 16 + (class1 * class2Count + class2) * recordSize;
      return advance === null ? 0 : view.getInt16(record + advance);
    }
    return 0;
  };
}
