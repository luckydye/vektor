/**
 * The series storage engine. A window is read as its newest chunk plus every
 * segment that chunk does not name; appends only ever add a segment.
 */

import { randomUUID } from "node:crypto";
import type { SpaceStore } from "#db/client/store.ts";
import type { SeriesRow } from "#db/schema/space.ts";
import { getFileStorage, listAllFiles } from "#files/storage.ts";
import { recordAppend, requireSeries, seriesPrefix } from "./catalog.ts";
import {
  compareStoredPoints,
  type DecodedObject,
  decodeHeader,
  decodeObject,
  encodeObject,
  HEADER_LENGTH_DIGITS,
  HEADER_PROBE_BYTES,
  headerLength,
  type ObjectHeader,
  type PointPosition,
  type SeriesPoint,
  type StoredPoint,
  TYPE_COLUMN,
} from "./format.ts";
import {
  SERIES_READ_DEADLINE_MS,
  SERIES_WRITE_DEADLINE_MS,
  SeriesInputError,
  seriesLimits,
  withDeadline,
} from "./limits.ts";
import { matchesAll, type SeriesPredicate } from "./predicates.ts";

const OBJECT_SUFFIX = ".tsc.br";
const LISTING_TTL_MS = 1000;
/** Windows one read or query may span. */
export const SERIES_MAX_WINDOWS = 10_000;
const WINDOW_CONCURRENCY = 8;
const MAX_FIELDS = 64;
const MAX_STRING_LENGTH = 16 * 1024;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function pad(value: number): string {
  return value.toString().padStart(15, "0");
}

export function windowMs(row: SeriesRow): number {
  return row.windowSeconds * 1000;
}

export function windowOf(row: SeriesRow, ts: number): number {
  return Math.floor(ts / windowMs(row)) * windowMs(row);
}

export function windowPrefix(seriesId: string, window: number): string {
  return `${seriesPrefix(seriesId)}${pad(window)}/`;
}

/** `s-{arrival}-{uuid}` or `c-{watermark}`, from a stored key. */
export function objectName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1, -OBJECT_SUFFIX.length);
}

export function chunkKey(seriesId: string, window: number, watermark: number): string {
  return `${windowPrefix(seriesId, window)}c-${pad(watermark)}${OBJECT_SUFFIX}`;
}

/** A segment's arrival or a chunk's watermark. */
export function objectStamp(name: string): number {
  return Number(name.slice(2, 17));
}

export function isChunk(key: string): boolean {
  return objectName(key).startsWith("c-");
}

/** `map` with at most {@link WINDOW_CONCURRENCY} calls in flight, in order. */
export async function mapLimited<T, R>(
  items: T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += WINDOW_CONCURRENCY) {
    results.push(
      ...(await Promise.all(items.slice(start, start + WINDOW_CONCURRENCY).map(map))),
    );
  }
  return results;
}

// ─── caches ─────────────────────────────────────────────────────────────────

/** Objects are immutable, so a key names the same bytes for as long as it exists. */
const objectCache = new Map<
  string,
  { value: DecodedObject | ObjectHeader; bytes: number }
>();
let cachedBytes = 0;
const inflight = new Map<string, Promise<DecodedObject | ObjectHeader>>();
const listings = new Map<string, { keys: string[]; at: number }>();

function cacheGet<T extends DecodedObject | ObjectHeader>(key: string): T | undefined {
  const entry = objectCache.get(key);
  if (!entry) return undefined;
  objectCache.delete(key);
  objectCache.set(key, entry);
  return entry.value as T;
}

function cachePut(key: string, value: DecodedObject | ObjectHeader, bytes: number): void {
  const limit = seriesLimits().cacheBytes;
  if (bytes > limit || objectCache.has(key)) return;
  objectCache.set(key, { value, bytes });
  cachedBytes += bytes;
  for (const [oldest, entry] of objectCache) {
    if (cachedBytes <= limit) break;
    objectCache.delete(oldest);
    cachedBytes -= entry.bytes;
  }
}

async function cached<T extends DecodedObject | ObjectHeader>(
  key: string,
  load: () => Promise<{ value: T; bytes: number }>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const loading = load().then(({ value, bytes }) => {
    cachePut(key, value, bytes);
    return value;
  });
  inflight.set(key, loading);
  try {
    return await loading;
  } finally {
    inflight.delete(key);
  }
}

/** Drop a window's cached listing after this process changed it. */
export function forgetListing(spaceId: string, seriesId: string, window: number): void {
  listings.delete(`${spaceId}/${windowPrefix(seriesId, window)}`);
}

// ─── objects ────────────────────────────────────────────────────────────────

async function readRange(spaceId: string, key: string, end: number): Promise<Buffer> {
  const stream = await getFileStorage().readStream(spaceId, key, { start: 0, end });
  if (!stream) throw new Error(`Series object vanished mid-read: ${key}`);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

export async function readHeader(spaceId: string, key: string): Promise<ObjectHeader> {
  const full = cacheGet<DecodedObject>(`o:${spaceId}/${key}`);
  if (full) return full.header;
  return cached(`h:${spaceId}/${key}`, async () => {
    let prefix = await readRange(spaceId, key, HEADER_PROBE_BYTES - 1);
    const end = HEADER_LENGTH_DIGITS + headerLength(prefix);
    if (prefix.length < end) prefix = await readRange(spaceId, key, end - 1);
    const header = decodeHeader(prefix);
    return { value: header, bytes: end };
  });
}

export async function readObject(spaceId: string, key: string): Promise<DecodedObject> {
  return cached(`o:${spaceId}/${key}`, async () => {
    const buffer = await getFileStorage().read(spaceId, key);
    if (!buffer) throw new Error(`Series object vanished mid-read: ${key}`);
    // Decoded JSON runs roughly ten times the brotli bytes.
    return {
      value: await decodeObject(buffer, objectName(key)),
      bytes: buffer.length * 10,
    };
  });
}

/** Every key under the window, listed fresh or from a listing under a second old. */
export async function listWindow(
  spaceId: string,
  seriesId: string,
  window: number,
  fresh = false,
): Promise<string[]> {
  const prefix = windowPrefix(seriesId, window);
  const cacheKey = `${spaceId}/${prefix}`;
  const hit = listings.get(cacheKey);
  if (!fresh && hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.keys;
  const at = Date.now();
  const keys = (await listAllFiles(getFileStorage(), spaceId, { prefix }))
    .map((file) => file.key)
    .filter((key) => key.endsWith(OBJECT_SUFFIX))
    .sort();
  listings.set(cacheKey, { keys, at });
  return keys;
}

export interface ResolvedWindow {
  /** The newest chunk, if any, and the segments it does not name. */
  keys: string[];
  chunk: { key: string; header: ObjectHeader } | null;
}

/** Rule 2: the newest chunk plus every segment it does not name. */
export async function resolveWindow(
  spaceId: string,
  keys: string[],
): Promise<ResolvedWindow> {
  const chunks = keys.filter(isChunk);
  const newest = chunks.at(-1);
  if (!newest) return { keys, chunk: null };
  const header = await readHeader(spaceId, newest);
  const subsumed = new Set(header.subsumes);
  const live = keys.filter((key) => !isChunk(key) && !subsumed.has(objectName(key)));
  return { keys: [newest, ...live], chunk: { key: newest, header } };
}

export async function windowPoints(
  spaceId: string,
  seriesId: string,
  window: number,
): Promise<StoredPoint[]> {
  const { keys } = await resolveWindow(
    spaceId,
    await listWindow(spaceId, seriesId, window),
  );
  const objects = await Promise.all(keys.map((key) => readObject(spaceId, key)));
  return objects.flatMap((object) => object.points).sort(compareStoredPoints);
}

/** Windows covering `[from, to)`, clipped to what may hold objects. */
export function windowsBetween(row: SeriesRow, from: number, to: number): number[] {
  if (row.oldestWindow === null) return [];
  const first = Math.max(windowOf(row, from), row.oldestWindow);
  const last = windowOf(row, Math.min(to, Date.now() + seriesLimits().maxFutureMs) - 1);
  const count = Math.floor((last - first) / windowMs(row)) + 1;
  if (count <= 0) return [];
  if (count > SERIES_MAX_WINDOWS) {
    throw new SeriesInputError(
      `The range spans ${count} windows; at most ${SERIES_MAX_WINDOWS} may be read at once`,
      422,
    );
  }
  return Array.from({ length: count }, (_, index) => first + index * windowMs(row));
}

// ─── append ─────────────────────────────────────────────────────────────────

function validatePoint(point: unknown): SeriesPoint {
  const { ts, type, fields } = (point ?? {}) as Record<string, unknown>;
  if (!Number.isSafeInteger(ts)) throw new SeriesInputError("ts must be an integer (ms)");
  if (typeof type !== "string" || type === "" || type.length > 128) {
    throw new SeriesInputError("type must be a string of 1-128 characters");
  }
  const input = (fields ?? {}) as Record<string, unknown>;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new SeriesInputError("fields must be an object");
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_FIELDS) {
    throw new SeriesInputError(`A point carries at most ${MAX_FIELDS} fields`);
  }
  const clean: SeriesPoint["fields"] = {};
  for (const [name, value] of entries) {
    if (!FIELD_PATTERN.test(name) || name === TYPE_COLUMN || name === "ts") {
      throw new SeriesInputError(`Invalid field name "${name}"`);
    }
    const valid =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= MAX_STRING_LENGTH);
    if (!valid) throw new SeriesInputError(`Invalid value for field "${name}"`);
    if (value !== null) clean[name] = value as string | number | boolean;
  }
  return { ts: ts as number, type, fields: clean };
}

export interface AppendResult {
  series: SeriesRow;
  points: SeriesPoint[];
  latestTs: number;
  count: number;
}

/**
 * Store a batch as one new segment per window it touches. The whole batch is
 * refused if any point is invalid or out of bounds.
 */
export async function appendPoints(
  store: SpaceStore,
  name: string,
  input: unknown[],
): Promise<AppendResult> {
  const limits = seriesLimits();
  if (!Array.isArray(input) || input.length === 0 || input.length > limits.maxBatch) {
    throw new SeriesInputError(`points must be an array of 1-${limits.maxBatch} points`);
  }
  const row = await requireSeries(store, name);
  const points = input.map(validatePoint);

  const arrival = Date.now();
  const oldestAllowed =
    row.retentionDays === null ? null : arrival - row.retentionDays * 86_400_000;
  const newestAllowed = arrival + limits.maxFutureMs;
  for (const point of points) {
    if (oldestAllowed !== null && point.ts < oldestAllowed) {
      throw new SeriesInputError("A point is older than the series' retention");
    }
    if (point.ts > newestAllowed) {
      throw new SeriesInputError("A point is too far in the future");
    }
  }

  const byWindow = new Map<number, SeriesPoint[]>();
  for (const point of points) {
    const window = windowOf(row, point.ts);
    byWindow.set(window, [...(byWindow.get(window) ?? []), point]);
  }

  const storage = getFileStorage();
  const writes = [...byWindow].map(async ([window, windowPoints]) => {
    const segment = `s-${pad(arrival)}-${randomUUID()}`;
    const stored = windowPoints
      .map((point, order) => ({ point, order }))
      .sort((a, b) => a.point.ts - b.point.ts || a.order - b.order)
      .map(({ point }, idx): StoredPoint => ({ ...point, src: segment, idx }));
    const buffer = await encodeObject(
      { series: row.id, name: row.name, window },
      stored,
      limits.maxColumnValues,
    );
    const key = `${windowPrefix(row.id, window)}${segment}${OBJECT_SUFFIX}`;
    const result = await withDeadline(
      storage.putConditional(store.spaceId, key, buffer, { ifNoneMatch: true }),
      SERIES_WRITE_DEADLINE_MS,
      "Series append",
    );
    if (!result.ok) throw new Error(`Series segment already exists: ${key}`);
    forgetListing(store.spaceId, row.id, window);
    return { window, bytes: buffer.length, points: windowPoints.length };
  });

  // Account for every segment that landed, even when a sibling failed.
  const settled = await Promise.allSettled(writes);
  const landed = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (landed.length > 0) {
    await recordAppend(
      store,
      row.id,
      landed.map((entry) => entry.window),
      landed.reduce((sum, entry) => sum + entry.points, 0),
      landed.reduce((sum, entry) => sum + entry.bytes, 0),
    );
  }
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;

  return {
    series: row,
    points,
    latestTs: Math.max(...points.map((point) => point.ts)),
    count: points.length,
  };
}

// ─── read ───────────────────────────────────────────────────────────────────

export interface ReadOptions {
  from: number;
  to: number;
  where?: SeriesPredicate[];
  limit?: number;
  cursor?: string;
  /** `desc` reads newest first; the cursor then pages further back in time. */
  order?: "asc" | "desc";
}

export interface ReadResult {
  points: SeriesPoint[];
  nextCursor: string | null;
}

/** A cursor names the last point returned, so it survives compaction. */
function encodeCursor(point: StoredPoint): string {
  return `${point.ts}:${point.src}:${point.idx}`;
}

function decodeCursor(cursor: string): PointPosition {
  const [ts, src, idx] = cursor.split(":");
  const parsed = { ts: Number(ts), src, idx: Number(idx) };
  if (!Number.isSafeInteger(parsed.ts) || !src || !Number.isSafeInteger(parsed.idx)) {
    throw new SeriesInputError("Invalid cursor");
  }
  return parsed;
}

function assertRange(from: unknown, to: unknown): asserts from is number {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    (from as number) >= (to as number)
  ) {
    throw new SeriesInputError("from and to must be integers (ms) with from < to");
  }
}

function publicPoint({ ts, type, fields }: StoredPoint): SeriesPoint {
  return { ts, type, fields };
}

/** Points in `[from, to)` in stable order, oldest or newest first, one page at a time. */
export async function readSeriesPoints(
  store: SpaceStore,
  name: string,
  options: ReadOptions,
): Promise<ReadResult> {
  assertRange(options.from, options.to);
  const limit = options.limit ?? 1000;
  const order = options.order ?? "asc";
  if (order !== "asc" && order !== "desc") {
    throw new SeriesInputError('order must be "asc" or "desc"');
  }
  const descending = order === "desc";
  const row = await requireSeries(store, name);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const where = options.where ?? [];
  // Windows disjoint in ts: reversing their order and each window's points is newest first.
  const windows = descending
    ? windowsBetween(
        row,
        options.from,
        Math.min(options.to, (after?.ts ?? Number.POSITIVE_INFINITY) + 1),
      ).reverse()
    : windowsBetween(
        row,
        Math.max(options.from, after?.ts ?? Number.NEGATIVE_INFINITY),
        options.to,
      );

  const read = async (): Promise<ReadResult> => {
    const collected: StoredPoint[] = [];
    for (let start = 0; start < windows.length && collected.length <= limit; ) {
      const batch = windows.slice(start, start + WINDOW_CONCURRENCY);
      start += batch.length;
      const pages = await Promise.all(
        batch.map((window) => windowPoints(store.spaceId, row.id, window)),
      );
      for (const point of pages.flatMap((page) => (descending ? page.reverse() : page))) {
        if (point.ts < options.from || point.ts >= options.to) continue;
        if (after) {
          const position = compareStoredPoints(point, after);
          if (descending ? position >= 0 : position <= 0) continue;
        }
        if (!matchesAll(point, where)) continue;
        collected.push(point);
      }
    }
    const page = collected.slice(0, limit);
    return {
      points: page.map(publicPoint),
      nextCursor: collected.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  };
  return withDeadline(read(), SERIES_READ_DEADLINE_MS, "Series read");
}
