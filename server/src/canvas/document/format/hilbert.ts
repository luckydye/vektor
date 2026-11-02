import type { BBox } from "#canvas/document/format/records.ts";

const GRID = 2 ** 32;
const HALF = 2 ** 31;

function cell(value: number): number {
  return Math.min(GRID - 1, Math.max(0, Math.floor(value) + HALF));
}

/**
 * The Hilbert key of a bbox's centre on a fixed grid of one-world-unit cells
 * centred on the origin (2³² per axis, clamped at the edges), so a key depends
 * only on its own bbox.
 */
export function hilbertKey(bbox: BBox): bigint {
  let x = cell((bbox[0] + bbox[2]) / 2);
  let y = cell((bbox[1] + bbox[3]) / 2);
  let key = 0n;
  for (let s = HALF; s >= 1; s /= 2) {
    const rx = x >= s ? 1 : 0;
    const ry = y >= s ? 1 : 0;
    key = (key << 2n) | BigInt((3 * rx) ^ ry);
    if (rx) x -= s;
    if (ry) y -= s;
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
  }
  return key;
}

/** Hilbert key order, ties by id. */
export function compareHilbert(
  a: { key: bigint; id: string },
  b: { key: bigint; id: string },
): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
