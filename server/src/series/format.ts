/**
 * The immutable series object: `{8-digit header length}{JSON header}{brotli
 * columnar body}`, so a short range read yields the header without the body.
 */

import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

export type SeriesValue = number | string | boolean | null;

export interface SeriesPoint {
  /** Event time, ms since the epoch. */
  ts: number;
  type: string;
  /** A null field and an absent one are the same thing. */
  fields: Record<string, SeriesValue>;
}

/** A point with the position that orders it: event time, source segment, index. */
export interface StoredPoint extends SeriesPoint {
  src: string;
  idx: number;
}

export type ColumnStats =
  | { type: "number"; nulls: number; min: number; max: number }
  | { type: "string"; nulls: number; values?: string[]; bloom?: string }
  | { type: "boolean"; nulls: number }
  | { type: "mixed"; nulls: number };

export interface ObjectHeader {
  v: 1;
  series: string;
  name: string;
  window: number;
  count: number;
  from: number;
  to: number;
  columns: Record<string, ColumnStats>;
  /** Chunks only: every segment absorbed, cumulatively. */
  subsumes?: string[];
  compactedAt?: number;
}

interface ObjectBody {
  t0: number;
  dt: number[];
  segments?: string[];
  src?: number[];
  idx?: number[];
  columns: Record<string, SeriesValue[]>;
}

export interface DecodedObject {
  header: ObjectHeader;
  points: StoredPoint[];
}

/** The reserved column holding each point's `type`. */
export const TYPE_COLUMN = "type";
export const HEADER_LENGTH_DIGITS = 8;
/** Enough for any header without bloom filters; a larger one costs a second read. */
export const HEADER_PROBE_BYTES = 16 * 1024;

const BLOOM_HASHES = 7;
const BLOOM_MAX_BYTES = 8 * 1024;

export type PointPosition = Pick<StoredPoint, "ts" | "src" | "idx">;

export function compareStoredPoints(a: PointPosition, b: PointPosition): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.src !== b.src) return a.src < b.src ? -1 : 1;
  return a.idx - b.idx;
}

/** A point's value in `column`, `type` included; undefined when it has none. */
export function pointValue(point: SeriesPoint, column: string): SeriesValue | undefined {
  if (column === TYPE_COLUMN) return point.type;
  if (column === "ts") return point.ts;
  const value = point.fields[column];
  return value === null ? undefined : value;
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function bloomPositions(value: string, bits: number): number[] {
  const h1 = fnv1a(value, 2166136261);
  const h2 = fnv1a(value, 3323198485) | 1;
  const positions: number[] = [];
  for (let index = 0; index < BLOOM_HASHES; index++) {
    positions.push(((h1 + Math.imul(index, h2)) >>> 0) % bits);
  }
  return positions;
}

function buildBloom(values: Iterable<string>, count: number): string {
  let bytes = 8;
  while (bytes < BLOOM_MAX_BYTES && bytes * 8 < count * 10) bytes *= 2;
  const filter = new Uint8Array(bytes);
  for (const value of values) {
    for (const position of bloomPositions(value, bytes * 8)) {
      filter[position >> 3] |= 1 << (position & 7);
    }
  }
  return Buffer.from(filter).toString("base64");
}

/** False only when `value` is certainly absent from the filter's set. */
export function bloomMayContain(bloom: string, value: string): boolean {
  const filter = Buffer.from(bloom, "base64");
  return bloomPositions(value, filter.length * 8).every(
    (position) => (filter[position >> 3] & (1 << (position & 7))) !== 0,
  );
}

function valueType(value: SeriesValue): "number" | "string" | "boolean" {
  return typeof value as "number" | "string" | "boolean";
}

function columnStats(values: SeriesValue[], maxColumnValues: number): ColumnStats {
  let nulls = 0;
  const types = new Set<string>();
  for (const value of values) {
    if (value === null) nulls++;
    else types.add(valueType(value));
  }
  if (types.size !== 1) return { type: "mixed", nulls };
  const [type] = types;

  if (type === "number") {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (value === null) continue;
      min = Math.min(min, value as number);
      max = Math.max(max, value as number);
    }
    return { type, nulls, min, max };
  }
  if (type === "boolean") return { type, nulls };

  const distinct = new Set(values.filter((value): value is string => value !== null));
  if (distinct.size <= maxColumnValues) {
    return { type: "string", nulls, values: [...distinct].sort() };
  }
  return { type: "string", nulls, bloom: buildBloom(distinct, distinct.size) };
}

/**
 * Encode points, already in {@link compareStoredPoints} order, as one object.
 * A segment names only itself as a source; a chunk carries every point's.
 */
export async function encodeObject(
  meta: Pick<ObjectHeader, "series" | "name" | "window" | "subsumes" | "compactedAt">,
  points: StoredPoint[],
  maxColumnValues: number,
): Promise<Buffer> {
  if (points.length === 0) throw new Error("A series object holds at least one point");

  const names = new Set<string>([TYPE_COLUMN]);
  for (const point of points)
    for (const name of Object.keys(point.fields)) names.add(name);

  const header: ObjectHeader = {
    v: 1,
    series: meta.series,
    name: meta.name,
    window: meta.window,
    count: points.length,
    from: points[0].ts,
    to: points[points.length - 1].ts,
    columns: {},
  };
  const t0 = points[0].ts;
  const body: ObjectBody = { t0, dt: [], columns: {} };

  let previous = t0;
  for (const point of points) {
    body.dt.push(point.ts - previous);
    previous = point.ts;
  }

  for (const name of [...names].sort()) {
    const values = points.map((point) => pointValue(point, name) ?? null);
    const stats = columnStats(values, maxColumnValues);
    header.columns[name] = stats;
    if (stats.type === "string" && stats.values) {
      const index = new Map(stats.values.map((value, position) => [value, position]));
      body.columns[name] = values.map((value) =>
        value === null ? null : (index.get(value as string) as number),
      );
    } else {
      body.columns[name] = values;
    }
  }

  if (meta.subsumes) {
    header.subsumes = meta.subsumes;
    header.compactedAt = meta.compactedAt;
    const segments = [...new Set(points.map((point) => point.src))].sort();
    const position = new Map(segments.map((segment, index) => [segment, index]));
    body.segments = segments;
    body.src = points.map((point) => position.get(point.src) as number);
    body.idx = points.map((point) => point.idx);
  }

  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  if (headerJson.length >= 10 ** HEADER_LENGTH_DIGITS) {
    throw new Error("Series object header is too large");
  }
  const bodyJson = Buffer.from(JSON.stringify(body), "utf8");
  const compressed = await brotliCompressAsync(bodyJson, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bodyJson.length,
    },
  });
  return Buffer.concat([
    Buffer.from(headerJson.length.toString().padStart(HEADER_LENGTH_DIGITS, "0")),
    headerJson,
    compressed,
  ]);
}

/** The header's byte length, from an object's first bytes. */
export function headerLength(prefix: Buffer): number {
  const digits = prefix.subarray(0, HEADER_LENGTH_DIGITS).toString("ascii");
  if (!/^\d{8}$/.test(digits)) throw new Error("Not a series object");
  return Number(digits);
}

/** Parse the header from a prefix that holds all of it. */
export function decodeHeader(prefix: Buffer): ObjectHeader {
  const length = headerLength(prefix);
  const end = HEADER_LENGTH_DIGITS + length;
  if (prefix.length < end) throw new Error("Series object header is truncated");
  return JSON.parse(prefix.subarray(HEADER_LENGTH_DIGITS, end).toString("utf8"));
}

/** Decode a whole object. `source` names the segment a segment's points came from. */
export async function decodeObject(
  buffer: Buffer,
  source: string,
): Promise<DecodedObject> {
  const header = decodeHeader(buffer);
  const bodyStart = HEADER_LENGTH_DIGITS + headerLength(buffer);
  const body: ObjectBody = JSON.parse(
    (await brotliDecompressAsync(buffer.subarray(bodyStart))).toString("utf8"),
  );

  const decoded = Object.entries(body.columns).map(([name, column]) => {
    const stats = header.columns[name];
    const dictionary = stats.type === "string" ? stats.values : undefined;
    return {
      name,
      values: dictionary
        ? column.map((value) => (value === null ? null : dictionary[value as number]))
        : column,
    };
  });

  const points: StoredPoint[] = [];
  let ts = body.t0;
  for (let index = 0; index < header.count; index++) {
    ts += body.dt[index];
    const point: StoredPoint = {
      ts,
      type: "",
      fields: {},
      src: body.segments ? body.segments[body.src?.[index] as number] : source,
      idx: body.idx ? body.idx[index] : index,
    };
    for (const { name, values } of decoded) {
      const value = values[index];
      if (value === null) continue;
      if (name === TYPE_COLUMN) point.type = value as string;
      else point.fields[name] = value;
    }
    points.push(point);
  }
  return { header, points };
}
