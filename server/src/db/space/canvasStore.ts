/**
 * The server side of the canvas object store (see docs/canvas-format.md,
 * Writing, Loading and Compaction): one working set per open canvas holding
 * the `seq` counter, the records not yet flushed and the segment map, never
 * the objects themselves.
 */

import { and, eq } from "drizzle-orm";
import { bboxIntersects, objectBounds, unionBBox } from "#canvas/agent/objectBounds.ts";
import { compareHilbert, hilbertKey } from "#canvas/document/format/hilbert.ts";
import { idHash, lookupOffsets } from "#canvas/document/format/lookup.ts";
import {
  applyRecord,
  type CanvasObject,
  compactBody,
  createObject,
  objectDeleted,
  objectRefs,
} from "#canvas/document/format/object.ts";
import { stateToGroups } from "#canvas/document/format/properties.ts";
import {
  assertBBox,
  type BBox,
  ByteWriter,
  decodeObjectPayload,
  decodeObjectSummary,
  encodeCursorRecord,
  encodeHeaderPayload,
  encodeObjectRecord,
  encodeRecord,
  HEADER_RECORD_BYTES,
  type ObjectSummary,
  PREAMBLE_BYTES,
  preamble,
  RecordKind,
  recordPayload,
  withSeq,
} from "#canvas/document/format/records.ts";
import { queryRTree } from "#canvas/document/format/rtree.ts";
import { streamRecords } from "#canvas/document/format/stream.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, revision } from "#db/schema/space.ts";
import {
  type BaseEntry,
  baseRecordLength,
  type CanvasBase,
  canvasPrefix,
  isCanvasBaseKey,
  newBaseKey,
  newFoldKey,
  parseCanvasBlobKey,
  putBlobStream,
  readCanvasBase,
  readSpans,
  segmentKey,
  writeCanvasBase,
} from "./canvasBase.ts";
import { nextChangeSeq } from "./changeSeq.ts";

/** Where one record lives: a blob, or the pending buffer while `bytes` is set. */
export interface RecordLocation {
  seq: number;
  blob: string | null;
  offset: number;
  length: number;
  bytes: Uint8Array | null;
}

export interface SegmentInfo {
  key: string;
  firstSeq: number;
  lastSeq: number;
  size: number;
}

/** An object with records in the live segments or the pending buffer. */
export interface SegmentMapEntry {
  /** The summary of its record with the highest `seq`. */
  summary: ObjectSummary;
  locations: RecordLocation[];
}

export interface CanvasWorkingSet {
  store: SpaceStore;
  documentId: string;
  /** Names this working set; a new one after a crash or a restore. */
  epoch: string;
  /** The last `seq` handed out. */
  seq: number;
  base: CanvasBase;
  /** The base header's bounds, grown by every record since. */
  bounds: BBox;
  /** Live segments, by `firstSeq`. */
  segments: SegmentInfo[];
  /** Records not yet flushed, by `seq`. */
  pending: RecordLocation[];
  map: Map<string, SegmentMapEntry>;
  /** Referenced id → ids of map objects whose latest summary names it. */
  reverse: Map<string, Set<string>>;
  /** Serializes appends, so `seq` follows the order frames were accepted in. */
  appending: Promise<unknown>;
  /** One flush at a time, so segments commit in `seq` order. */
  flushing: Promise<unknown>;
  /** One compaction at a time. */
  compacting: Promise<unknown>;
}

/** Flush once this much is pending. */
export const FLUSH_BYTES = 64 * 1024;
/** Flush this long after the oldest pending record. */
export const FLUSH_DELAY_MS = 1000;
/** Input records one compaction chunk reads at a time. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const SEGMENT_MERGE_COUNT = 4;
const SEGMENT_MERGE_RATIO = 2;
const REWRITE_RATIO = 0.25;
const REWRITE_MIN_BYTES = 1024 * 1024;
/** Garbage is deleted only after this long, which covers open reads and a rewrite's commit. */
export const GC_AGE_MS = 60 * 60 * 1000;

const MAX_ID_LENGTH = 256;
const MAX_REFS = 64;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

const workingSets = new Map<string, Promise<CanvasWorkingSet>>();

function workingSetKey(spaceId: string, documentId: string): string {
  return `${spaceId}:${documentId}`;
}

/** The canvas's working set, opened on first use. */
export function canvasWorkingSet(
  s: SpaceStore,
  documentId: string,
): Promise<CanvasWorkingSet> {
  const key = workingSetKey(s.spaceId, documentId);
  let opening = workingSets.get(key);
  if (!opening) {
    opening = openCanvasWorkingSet(s, documentId);
    workingSets.set(key, opening);
    opening.catch(() => {
      if (workingSets.get(key) === opening) workingSets.delete(key);
    });
  }
  return opening;
}

/** Forgets the working set; callers flush first. */
export function dropCanvasWorkingSet(spaceId: string, documentId: string): void {
  workingSets.delete(workingSetKey(spaceId, documentId));
}

export function openCanvasWorkingSetKeys(): string[] {
  return [...workingSets.keys()];
}

export async function canvasBaseKey(s: SpaceStore, documentId: string): Promise<string> {
  const row = await one(
    s.db
      .select({ contentKey: document.contentKey })
      .from(document)
      .where(eq(document.id, documentId)),
  );
  if (!row) throw new Error(`Canvas ${documentId} does not exist`);
  if (!isCanvasBaseKey(row.contentKey)) {
    throw new Error(`Canvas ${documentId} has no base; it was never migrated`);
  }
  return row.contentKey;
}

async function listSegments(s: SpaceStore, documentId: string): Promise<SegmentInfo[]> {
  const found: SegmentInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await s.platform.blobStore.list(s.spaceId, {
      prefix: `${canvasPrefix(documentId)}seg-`,
      cursor,
    });
    for (const file of page.files) {
      const name = parseCanvasBlobKey(file.key);
      if (name?.kind === "segment") {
        found.push({
          key: file.key,
          firstSeq: name.firstSeq,
          lastSeq: name.lastSeq,
          size: file.size,
        });
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return found;
}

/** Listed segments neither the base covers nor another listed segment contains. */
function liveSegments(listed: SegmentInfo[], coveredSeq: number): SegmentInfo[] {
  return listed
    .filter((segment) => segment.lastSeq > coveredSeq)
    .filter(
      (segment) =>
        !listed.some(
          (other) =>
            other !== segment &&
            other.firstSeq <= segment.firstSeq &&
            other.lastSeq >= segment.lastSeq &&
            (other.firstSeq !== segment.firstSeq || other.lastSeq !== segment.lastSeq),
        ),
    )
    .sort((a, b) => a.firstSeq - b.firstSeq)
    .map((segment) => {
      if (segment.firstSeq <= coveredSeq) {
        throw new Error(
          `Segment ${segment.key} straddles the base's covered seq ${coveredSeq}`,
        );
      }
      return segment;
    });
}

function indexRecord(
  ws: CanvasWorkingSet,
  summary: ObjectSummary,
  location: RecordLocation,
): void {
  const previous = ws.map.get(summary.id);
  if (previous && previous.summary.seq > summary.seq) {
    previous.locations.push(location);
    previous.locations.sort((a, b) => a.seq - b.seq);
    return;
  }
  if (previous) unlinkRefs(ws, previous.summary);
  const entry = previous ?? { summary, locations: [] };
  entry.summary = summary;
  entry.locations.push(location);
  ws.map.set(summary.id, entry);
  for (const ref of summary.refs) {
    let ids = ws.reverse.get(ref);
    if (!ids) {
      ids = new Set();
      ws.reverse.set(ref, ids);
    }
    ids.add(summary.id);
  }
}

function unlinkRefs(ws: CanvasWorkingSet, summary: ObjectSummary): void {
  for (const ref of summary.refs) {
    const ids = ws.reverse.get(ref);
    ids?.delete(summary.id);
    if (ids?.size === 0) ws.reverse.delete(ref);
  }
}

async function* blobRecords(
  s: SpaceStore,
  key: string,
  start: number,
  end: number,
): AsyncGenerator<{
  bytes: Uint8Array;
  payload: Uint8Array;
  offset: number;
  kind: number;
}> {
  if (end <= start) return;
  const stream = await s.platform.blobStore.readStream(s.spaceId, key, {
    start,
    end: end - 1,
  });
  if (!stream) throw new Error(`Canvas blob ${key} is missing from storage`);
  for await (const record of streamRecords(stream, { preamble: false })) {
    yield {
      bytes: encodeRecord(record.kind as RecordKind, record.payload),
      payload: record.payload,
      offset: start + record.offset,
      kind: record.kind,
    };
  }
}

/** Builds a working set: reads the base's tables and streams the live segments once. */
export async function openCanvasWorkingSet(
  s: SpaceStore,
  documentId: string,
): Promise<CanvasWorkingSet> {
  const base = await readCanvasBase(s, await canvasBaseKey(s, documentId));
  return workingSetOver(s, documentId, base, await listSegments(s, documentId));
}

async function workingSetOver(
  s: SpaceStore,
  documentId: string,
  base: CanvasBase,
  listed: SegmentInfo[],
): Promise<CanvasWorkingSet> {
  const segments = liveSegments(listed, base.header.coveredSeq);
  const ws: CanvasWorkingSet = {
    store: s,
    documentId,
    epoch: crypto.randomUUID(),
    seq: segments.at(-1)?.lastSeq ?? base.header.coveredSeq,
    base,
    bounds: base.header.bounds,
    segments,
    pending: [],
    map: new Map(),
    reverse: new Map(),
    appending: Promise.resolve(),
    flushing: Promise.resolve(),
    compacting: Promise.resolve(),
  };
  for (const segment of segments) {
    for await (const record of blobRecords(
      s,
      segment.key,
      PREAMBLE_BYTES,
      segment.size,
    )) {
      if (record.kind !== RecordKind.object) continue;
      const summary = decodeObjectSummary(record.payload);
      indexRecord(ws, summary, {
        seq: summary.seq,
        blob: segment.key,
        offset: record.offset,
        length: record.bytes.length,
        bytes: null,
      });
      if (!summary.deleted) ws.bounds = unionBBox(ws.bounds, summary.bbox) as BBox;
    }
  }
  return ws;
}

/** Offsets of base records whose id is `id`, verified by reading them. */
async function baseOffsetsOf(base: CanvasBase, s: SpaceStore, ids: Iterable<string>) {
  const candidates = new Map<number, string>();
  for (const id of ids) {
    for (const offset of lookupOffsets(base.ids, idHash(id))) candidates.set(offset, id);
  }
  const bytes = await readSpans(
    s,
    base.key,
    [...candidates.keys()].map((offset) => ({
      offset,
      length: baseRecordLength(base, offset),
    })),
  );
  const found = new Map<string, { offset: number; bytes: Uint8Array }>();
  for (const [offset, record] of bytes) {
    const id = candidates.get(offset) as string;
    if (decodeObjectSummary(recordPayload(record)).id === id)
      found.set(id, { offset, bytes: record });
  }
  return found;
}

function validateSummary(summary: ObjectSummary, payloadLength: number): void {
  if (!summary.id || summary.id.length > MAX_ID_LENGTH)
    throw new Error("Invalid canvas object id");
  if (
    summary.refs.length > MAX_REFS ||
    summary.refs.some((ref) => ref.length > MAX_ID_LENGTH)
  ) {
    throw new Error("Invalid canvas object refs");
  }
  if (payloadLength > MAX_RECORD_BYTES) throw new Error("Canvas record too large");
  assertBBox(summary.bbox);
}

/**
 * Orders a frame's `object` records: each gets the next `seq` and goes to the pending
 * buffer. Drops malformed records and records without `full` for ids that
 * exist in neither the map nor the base. Returns the accepted records, encoded
 * with their `seq`, for the broadcast.
 */
export function appendCanvasRecords(
  ws: CanvasWorkingSet,
  records: readonly Uint8Array[],
): Promise<Uint8Array[]> {
  const run = ws.appending.then(async () => {
    const parsed = records.flatMap((record) => {
      try {
        if (record[0] !== RecordKind.object) throw new Error("Not an object record");
        const payload = recordPayload(record);
        const summary = decodeObjectSummary(payload);
        validateSummary(summary, payload.length);
        decodeObjectPayload(payload);
        return [{ payload, summary }];
      } catch {
        return [];
      }
    });
    const unknown = parsed
      .filter(({ summary }) => !summary.full && !ws.map.has(summary.id))
      .map(({ summary }) => summary.id);
    const inBase =
      unknown.length > 0 ? await baseOffsetsOf(ws.base, ws.store, unknown) : new Map();
    const accepted: Uint8Array[] = [];
    for (const { payload, summary } of parsed) {
      if (!summary.full && !ws.map.has(summary.id) && !inBase.has(summary.id)) continue;
      const seq = ++ws.seq;
      const bytes = encodeRecord(RecordKind.object, withSeq(payload, seq));
      const location = { seq, blob: null, offset: 0, length: bytes.length, bytes };
      ws.pending.push(location);
      indexRecord(ws, { ...summary, seq }, location);
      if (!summary.deleted) ws.bounds = unionBBox(ws.bounds, summary.bbox) as BBox;
      accepted.push(bytes);
    }
    return accepted;
  });
  ws.appending = run.catch(() => undefined);
  return run;
}

export function pendingBytes(ws: CanvasWorkingSet): number {
  return ws.pending.reduce((sum, location) => sum + location.length, 0);
}

/**
 * Writes the pending records as one segment. Resolves with the flushed `seq`
 * and the bounds, or null when nothing was pending. A failed write leaves the
 * records pending, to be retried under the same name.
 */
export function flushCanvas(
  ws: CanvasWorkingSet,
): Promise<{ seq: number; bounds: BBox } | null> {
  const run = ws.flushing.then(async () => {
    const batch = ws.pending.slice();
    if (batch.length === 0) return null;
    const epoch = ws.epoch;
    const first = batch[0].seq;
    const last = batch[batch.length - 1].seq;
    const key = segmentKey(ws.documentId, first, last);
    const writer = new ByteWriter();
    writer.raw(preamble());
    const offsets = batch.map((location) => {
      const offset = writer.length;
      writer.raw(location.bytes as Uint8Array);
      return offset;
    });
    await ws.store.platform.blobStore.put(
      ws.store.spaceId,
      key,
      Buffer.from(writer.finish()),
    );
    // A restore while the write ran covered these records; the segment is garbage.
    if (ws.epoch !== epoch) return null;
    batch.forEach((location, i) => {
      location.blob = key;
      location.offset = offsets[i];
      location.bytes = null;
    });
    ws.pending.splice(0, batch.length);
    ws.segments.push({ key, firstSeq: first, lastSeq: last, size: writer.length });
    return { seq: last, bounds: ws.bounds };
  });
  ws.flushing = run.catch(() => undefined);
  return run;
}

/** A load's view of the working set, taken when it starts: records are immutable, locations are copied. */
interface CanvasReadView {
  store: SpaceStore;
  epoch: string;
  seq: number;
  base: CanvasBase;
  segments: SegmentInfo[];
  pending: RecordLocation[];
  map: Map<string, SegmentMapEntry>;
  reverse: Map<string, Set<string>>;
}

function readView(ws: CanvasWorkingSet): CanvasReadView {
  const map = new Map<string, SegmentMapEntry>();
  for (const [id, entry] of ws.map) {
    map.set(id, {
      summary: entry.summary,
      locations: entry.locations.map((location) => ({ ...location })),
    });
  }
  const reverse = new Map<string, Set<string>>();
  for (const [ref, ids] of ws.reverse) reverse.set(ref, new Set(ids));
  return {
    store: ws.store,
    epoch: ws.epoch,
    seq: ws.seq,
    base: ws.base,
    segments: ws.segments.slice(),
    pending: ws.pending.map((location) => ({ ...location })),
    map,
    reverse,
  };
}

/** Reads `locations` grouped by blob, coalescing each blob's ranges. */
async function readLocations(
  s: SpaceStore,
  locations: readonly RecordLocation[],
): Promise<Map<RecordLocation, Uint8Array>> {
  const byBlob = new Map<string, RecordLocation[]>();
  const result = new Map<RecordLocation, Uint8Array>();
  for (const location of locations) {
    if (location.bytes) {
      result.set(location, location.bytes);
      continue;
    }
    const blob = location.blob as string;
    byBlob.set(blob, [...(byBlob.get(blob) ?? []), location]);
  }
  for (const [blob, group] of byBlob) {
    const bytes = await readSpans(s, blob, group);
    for (const location of group)
      result.set(location, bytes.get(location.offset) as Uint8Array);
  }
  return result;
}

/** A query of `POST …/canvas`. */
export interface CanvasLoadQuery {
  view?: BBox;
  ids?: string[];
  since?: number;
  epoch?: string;
}

export class CanvasCatchUpError extends Error {}

/** Why `since` cannot be answered from the records: another epoch, or a base rewrite past it. */
export function assertCanCatchUp(ws: CanvasWorkingSet, query: CanvasLoadQuery): void {
  if (query.since === undefined) return;
  if (query.epoch !== ws.epoch || ws.base.header.coveredSeq > query.since) {
    throw new CanvasCatchUpError("Cannot catch up; reload the canvas");
  }
}

/**
 * Streams a load response: a `cursor`, then for every matching object its
 * base record and its segment records, which the client merges.
 */
export async function* loadCanvas(
  ws: CanvasWorkingSet,
  query: CanvasLoadQuery,
): AsyncGenerator<Uint8Array> {
  assertCanCatchUp(ws, query);
  const view = readView(ws);
  yield preamble();
  yield encodeCursorRecord(view.epoch);

  if (query.since !== undefined) {
    yield* catchUp(view, query.since);
    return;
  }
  if (!query.view && !query.ids) {
    yield* everything(view);
    return;
  }

  const sent = new Map<string, string[]>();
  const sendBatch = async function* (
    records: Iterable<{ id: string; refs: string[]; bytes: Uint8Array[] }>,
  ) {
    for (const record of records) {
      if (sent.has(record.id)) continue;
      sent.set(record.id, record.refs);
      yield* record.bytes;
    }
  };

  if (query.view) {
    const rect = query.view;
    const hits = queryRTree(view.base.tree, rect).map(
      (leaf) => view.base.tree.offsets[leaf],
    );
    const records = await readSpans(
      view.store,
      view.base.key,
      hits.map((offset) => ({ offset, length: baseRecordLength(view.base, offset) })),
    );
    for (const offset of hits) {
      const bytes = records.get(offset) as Uint8Array;
      const summary = decodeObjectSummary(recordPayload(bytes));
      // An object with segment records matches by its latest summary instead.
      if (view.map.has(summary.id) || sent.has(summary.id)) continue;
      sent.set(summary.id, summary.refs);
      yield bytes;
    }
    const mapHits = [...view.map]
      .filter(
        ([, entry]) => !entry.summary.deleted && bboxIntersects(entry.summary.bbox, rect),
      )
      .map(([id]) => id);
    yield* sendBatch(await objectRecords(view, mapHits, false));
  }

  if (query.ids) {
    const named = query.ids.filter((id) => !sent.has(id));
    const found = await objectRecords(view, named, true);
    yield* sendBatch(found);
    const foundIds = new Set(found.map((record) => record.id));
    for (const id of named) {
      if (foundIds.has(id)) continue;
      // Gone for good: a base rewrite dropped it. The client drops it too.
      sent.set(id, []);
      yield encodeObjectRecord({
        id,
        seq: view.seq,
        bbox: [0, 0, 0, 0],
        refs: [],
        deleted: true,
        full: false,
        groups: [],
        body: new Uint8Array(0),
      });
    }
  }

  // Referencing, transitively: a client holding an object holds what references it.
  let frontier = [...sent.keys()];
  while (frontier.length > 0) {
    const referencing = await referencingRecords(view, frontier, sent);
    frontier = referencing.map((record) => record.id);
    yield* sendBatch(referencing);
  }

  // Referenced, one hop: a client holding a connector holds its endpoints.
  const endpoints = new Set<string>();
  for (const refs of sent.values())
    for (const ref of refs) if (!sent.has(ref)) endpoints.add(ref);
  yield* sendBatch(await objectRecords(view, [...endpoints], false));
}

/** Each object's base record and segment records. Deleted objects only with `deleted`. */
async function objectRecords(
  view: CanvasReadView,
  ids: readonly string[],
  deleted: boolean,
): Promise<{ id: string; refs: string[]; bytes: Uint8Array[] }[]> {
  if (ids.length === 0) return [];
  const live = ids.filter((id) => {
    const entry = view.map.get(id);
    return !entry || deleted || !entry.summary.deleted;
  });
  const fromBase = await baseOffsetsOf(view.base, view.store, live);
  const locations = live.flatMap((id) => view.map.get(id)?.locations ?? []);
  const segmentBytes = await readLocations(view.store, locations);
  return live.flatMap((id) => {
    const entry = view.map.get(id);
    const base = fromBase.get(id);
    if (!entry && !base) return [];
    const bytes = [
      ...(base ? [base.bytes] : []),
      ...(entry?.locations.map((location) => segmentBytes.get(location) as Uint8Array) ??
        []),
    ];
    const refs = entry
      ? entry.summary.refs
      : decodeObjectSummary(recordPayload((base as { bytes: Uint8Array }).bytes)).refs;
    return [{ id, refs, bytes }];
  });
}

/** Live objects referencing any of `ids` that were not sent yet. */
async function referencingRecords(
  view: CanvasReadView,
  ids: readonly string[],
  sent: ReadonlyMap<string, string[]>,
): Promise<{ id: string; refs: string[]; bytes: Uint8Array[] }[]> {
  const candidates = new Set<string>();
  const baseOffsets = new Set<number>();
  for (const id of ids) {
    for (const offset of lookupOffsets(view.base.refs, idHash(id)))
      baseOffsets.add(offset);
    for (const referencing of view.reverse.get(id) ?? []) candidates.add(referencing);
  }
  const targets = new Set(ids);
  const records = await readSpans(
    view.store,
    view.base.key,
    [...baseOffsets].map((offset) => ({
      offset,
      length: baseRecordLength(view.base, offset),
    })),
  );
  for (const bytes of records.values()) {
    const summary = decodeObjectSummary(recordPayload(bytes));
    if (view.map.has(summary.id)) continue;
    if (summary.refs.some((ref) => targets.has(ref))) candidates.add(summary.id);
  }
  const fresh = [...candidates].filter((id) => !sent.has(id));
  return objectRecords(view, fresh, false);
}

/** Every record after `since`, from the segments and the pending buffer. */
async function* catchUp(view: CanvasReadView, since: number): AsyncGenerator<Uint8Array> {
  for (const segment of view.segments) {
    if (segment.lastSeq <= since) continue;
    for await (const record of blobRecords(
      view.store,
      segment.key,
      PREAMBLE_BYTES,
      segment.size,
    )) {
      if (decodeObjectSummary(record.payload).seq > since) yield record.bytes;
    }
  }
  for (const location of view.pending) {
    if (location.seq > since) yield location.bytes as Uint8Array;
  }
}

/** Every live object: the base front to back, then the objects with segment records. */
async function* everything(view: CanvasReadView): AsyncGenerator<Uint8Array> {
  const offsets = view.base.tree.offsets;
  if (offsets.length > 0) {
    for await (const record of blobRecords(
      view.store,
      view.base.key,
      offsets[0],
      view.base.size,
    )) {
      if (view.map.has(decodeObjectSummary(record.payload).id)) continue;
      yield record.bytes;
    }
  }
  const ids = [...view.map]
    .filter(([, entry]) => !entry.summary.deleted)
    .map(([id]) => id);
  for (let i = 0; i < ids.length; i += 256) {
    for (const record of await objectRecords(view, ids.slice(i, i + 256), false)) {
      yield* record.bytes;
    }
  }
}

/** One object merged from its records, with the summary of the latest. */
interface MergedObject {
  object: CanvasObject;
  summary: ObjectSummary;
  full: boolean;
  baseOffset: number | null;
}

function mergeRecords(id: string, records: readonly Uint8Array[]): MergedObject {
  const object = createObject(id);
  let summary: ObjectSummary | null = null;
  let full = false;
  for (const bytes of records) {
    const record = decodeObjectPayload(recordPayload(bytes));
    applyRecord(object, record);
    full ||= record.full;
    if (!summary || record.seq >= summary.seq) summary = record;
  }
  if (!summary) throw new Error(`No records for canvas object ${id}`);
  return { object, summary, full, baseOffset: null };
}

/**
 * Merges each object from its base record and its segment records, those in
 * `segments` only when given, the pending buffer included otherwise.
 */
async function mergedObjects(
  view: Pick<CanvasReadView, "store" | "base" | "map">,
  ids: readonly string[],
  segments: ReadonlySet<string> | null,
): Promise<Map<string, MergedObject>> {
  const fromBase = await baseOffsetsOf(view.base, view.store, ids);
  const locationsOf = (id: string) =>
    (view.map.get(id)?.locations ?? []).filter(
      (location) => !segments || (location.blob !== null && segments.has(location.blob)),
    );
  const segmentBytes = await readLocations(view.store, ids.flatMap(locationsOf));
  const merged = new Map<string, MergedObject>();
  for (const id of ids) {
    const base = fromBase.get(id);
    const records = [
      ...(base ? [base.bytes] : []),
      ...locationsOf(id).map((location) => segmentBytes.get(location) as Uint8Array),
    ];
    if (records.length === 0) continue;
    const result = mergeRecords(id, records);
    result.baseOffset = base?.offset ?? null;
    merged.set(id, result);
  }
  return merged;
}

/** The state of each object as merged now, deleted ones included. */
export async function readCanvasObjects(
  ws: CanvasWorkingSet,
  ids: readonly string[],
): Promise<Map<string, CanvasObject>> {
  const merged = await mergedObjects(readView(ws), ids, null);
  return new Map([...merged].map(([id, entry]) => [id, entry.object]));
}

/** Every live object, merged; the whole canvas in memory, for describe, export and search. */
export async function readAllCanvasObjects(
  ws: CanvasWorkingSet,
): Promise<CanvasObject[]> {
  const view = readView(ws);
  const objects: CanvasObject[] = [];
  const offsets = view.base.tree.offsets;
  if (offsets.length > 0) {
    for await (const record of blobRecords(
      view.store,
      view.base.key,
      offsets[0],
      view.base.size,
    )) {
      const id = decodeObjectSummary(record.payload).id;
      if (view.map.has(id)) continue;
      objects.push(mergeRecords(id, [record.bytes]).object);
    }
  }
  const ids = [...view.map.keys()];
  for (let i = 0; i < ids.length; i += 256) {
    for (const entry of (
      await mergedObjects(view, ids.slice(i, i + 256), null)
    ).values()) {
      if (!objectDeleted(entry.object)) objects.push(entry.object);
    }
  }
  return objects;
}

/** Every object of a base alone, as a revision holds it; segments never apply. */
export async function readBaseObjects(
  s: SpaceStore,
  key: string,
): Promise<CanvasObject[]> {
  const base = await readCanvasBase(s, key);
  const objects: CanvasObject[] = [];
  const offsets = base.tree.offsets;
  if (offsets.length === 0) return objects;
  for await (const record of blobRecords(s, key, offsets[0], base.size)) {
    objects.push(
      mergeRecords(decodeObjectSummary(record.payload).id, [record.bytes]).object,
    );
  }
  return objects;
}

/** Runs `work` after every compaction already queued, never two at once. */
function compactionStep<T>(ws: CanvasWorkingSet, work: () => Promise<T>): Promise<T> {
  const run = ws.compacting.then(work);
  ws.compacting = run.catch(() => undefined);
  return run;
}

/** Merges adjacent segments and rewrites the base when due; call after a flush. */
export function compactCanvas(ws: CanvasWorkingSet): Promise<void> {
  return compactionStep(ws, async () => {
    while (await mergeSegments(ws)) {}
    const segmentBytes = ws.segments.reduce((sum, segment) => sum + segment.size, 0);
    if (
      segmentBytes > REWRITE_RATIO * ws.base.size &&
      segmentBytes >= REWRITE_MIN_BYTES
    ) {
      await rewriteBase(ws);
    }
  });
}

/** Flushes and rewrites the base so it covers every broadcast op; returns its key. */
export async function canvasRevisionBase(ws: CanvasWorkingSet): Promise<string> {
  await flushCanvas(ws);
  await compactionStep(ws, () => rewriteBase(ws));
  return ws.base.key;
}

function hilbertOrder<T extends { id: string; bbox: BBox }>(
  items: T[],
): (T & { key: bigint })[] {
  return items
    .map((item) => ({ ...item, key: hilbertKey(item.bbox) }))
    .sort(compareHilbert);
}

function chunks<T extends { length: number }>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.length > CHUNK_BYTES) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.length;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/**
 * Size-tiered: merges the first 4 adjacent segments within 2× of each other
 * into one, record per id. Returns whether it merged.
 */
async function mergeSegments(ws: CanvasWorkingSet): Promise<boolean> {
  const segments = ws.segments;
  let start = -1;
  for (let i = 0; i + SEGMENT_MERGE_COUNT <= segments.length; i++) {
    const sizes = segments
      .slice(i, i + SEGMENT_MERGE_COUNT)
      .map((segment) => segment.size);
    if (Math.max(...sizes) <= SEGMENT_MERGE_RATIO * Math.min(...sizes)) {
      start = i;
      break;
    }
  }
  if (start < 0) return false;
  const window = segments.slice(start, start + SEGMENT_MERGE_COUNT);
  const keys = new Set(window.map((segment) => segment.key));
  const epoch = ws.epoch;
  const view = readView(ws);
  const items = hilbertOrder(
    [...view.map]
      .map(([id, entry]) => ({
        id,
        bbox: entry.summary.bbox,
        locations: entry.locations.filter(
          (location) => location.blob && keys.has(location.blob),
        ),
      }))
      .filter((item) => item.locations.length > 0)
      .map((item) => ({
        ...item,
        length: item.locations.reduce((sum, l) => sum + l.length, 0),
      })),
  );
  const firstSeq = window[0].firstSeq;
  const lastSeq = window[window.length - 1].lastSeq;
  const key = segmentKey(ws.documentId, firstSeq, lastSeq);
  const written = new Map<string, RecordLocation>();
  let size = PREAMBLE_BYTES;

  async function* output(): AsyncGenerator<Uint8Array> {
    yield preamble();
    for (const chunk of chunks(items)) {
      const bytes = await readLocations(
        view.store,
        chunk.flatMap((item) => item.locations),
      );
      for (const item of chunk) {
        const merged = mergeRecords(
          item.id,
          item.locations.map((location) => bytes.get(location) as Uint8Array),
        );
        const record = encodeObjectRecord({
          ...merged.summary,
          full: merged.full,
          groups: stateToGroups(merged.object.properties),
          body: merged.object.body ?? new Uint8Array(0),
        });
        written.set(item.id, {
          seq: merged.summary.seq,
          blob: key,
          offset: size,
          length: record.length,
          bytes: null,
        });
        size += record.length;
        yield record;
      }
    }
  }

  await putBlobStream(ws.store, key, output());
  if (ws.epoch !== epoch) return false;
  for (const [id, location] of written) {
    const entry = ws.map.get(id);
    if (!entry) continue;
    entry.locations = [
      ...entry.locations.filter((l) => !(l.blob && keys.has(l.blob))),
      location,
    ].sort((a, b) => a.seq - b.seq);
  }
  ws.segments = [
    ...ws.segments.filter(
      (segment) => !keys.has(segment.key) && segment.firstSeq < firstSeq,
    ),
    { key, firstSeq, lastSeq, size },
    ...ws.segments.filter(
      (segment) => !keys.has(segment.key) && segment.firstSeq > lastSeq,
    ),
  ];
  return true;
}

/** Points the row at `to`, only while it still names `from`. */
async function commitBaseKey(
  s: SpaceStore,
  documentId: string,
  from: string,
  to: string,
): Promise<boolean> {
  return s.tx(async (tx) => {
    const changeSeq = await nextChangeSeq(tx);
    const rows = await many(
      tx.db
        .update(document)
        .set({ contentKey: to, content: "", changeSeq, updatedAt: new Date() })
        .where(and(eq(document.id, documentId), eq(document.contentKey, from)))
        .returning({ id: document.id }),
    );
    return rows.length > 0;
  });
}

/**
 * Folds the live segments into a new base, reading every blob sequentially or
 * in coalesced ranges: the changed objects are merged into a fold file, then
 * the old base's unchanged records and the fold are streamed out in Hilbert
 * order behind fresh tables.
 */
async function rewriteBase(ws: CanvasWorkingSet): Promise<void> {
  const covered = ws.segments.slice();
  if (covered.length === 0) return;
  const s = ws.store;
  const epoch = ws.epoch;
  const view = readView(ws);
  const base = view.base;
  const coveredSeq = covered[covered.length - 1].lastSeq;
  const coveredKeys = new Set(covered.map((segment) => segment.key));

  // 1. The changed objects, and the connectors referencing them, transitively.
  const changed = new Map<string, BBox>();
  for (const [id, entry] of view.map) {
    if (entry.locations.some((l) => l.blob && coveredKeys.has(l.blob)))
      changed.set(id, entry.summary.bbox);
  }
  let frontier = [...changed.keys()];
  while (frontier.length > 0) {
    const next: string[] = [];
    const offsets = new Set<number>();
    for (const id of frontier) {
      for (const offset of lookupOffsets(base.refs, idHash(id))) offsets.add(offset);
      for (const referencing of view.reverse.get(id) ?? []) {
        if (!changed.has(referencing)) {
          changed.set(
            referencing,
            (view.map.get(referencing) as SegmentMapEntry).summary.bbox,
          );
          next.push(referencing);
        }
      }
    }
    const targets = new Set(frontier);
    const records = await readSpans(
      s,
      base.key,
      [...offsets].map((offset) => ({ offset, length: baseRecordLength(base, offset) })),
    );
    for (const bytes of records.values()) {
      const summary = decodeObjectSummary(recordPayload(bytes));
      if (changed.has(summary.id) || !summary.refs.some((ref) => targets.has(ref)))
        continue;
      changed.set(summary.id, view.map.get(summary.id)?.summary.bbox ?? summary.bbox);
      next.push(summary.id);
    }
    frontier = next;
  }

  // 2.–3. Fold the changed objects, in Hilbert order, into a temporary file.
  const ordered = hilbertOrder([...changed].map(([id, bbox]) => ({ id, bbox }))).map(
    (item) => ({
      ...item,
      length:
        (view.map.get(item.id)?.locations ?? []).reduce((sum, l) => sum + l.length, 0) +
        1024,
    }),
  );
  const removedBaseOffsets = new Set<number>();
  const folded: (BaseEntry & { id: string })[] = [];
  const foldKey = newFoldKey(ws.documentId);

  async function* fold(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks(ordered)) {
      const merged = await mergedObjects(
        view,
        chunk.map((item) => item.id),
        coveredKeys,
      );
      // A connector's route needs its endpoints, read for their geometry only.
      const geometry = new Map([...merged].map(([id, entry]) => [id, entry.object]));
      let missing = endpointsMissing(geometry);
      while (missing.length > 0) {
        const hop = await mergedObjects(view, missing, coveredKeys);
        for (const [id, entry] of hop) geometry.set(id, entry.object);
        for (const id of missing)
          if (!geometry.has(id)) geometry.set(id, createObject(id));
        missing = endpointsMissing(geometry);
      }
      const lookup = (id: string) => {
        const object = geometry.get(id);
        return object && object.properties.size > 0 && !objectDeleted(object)
          ? object
          : undefined;
      };
      for (const item of chunk) {
        const entry = merged.get(item.id);
        if (!entry) continue;
        if (entry.baseOffset !== null) removedBaseOffsets.add(entry.baseOffset);
        if (objectDeleted(entry.object)) continue;
        const bbox = unionBBox(
          entry.summary.bbox,
          objectBounds(entry.object, lookup),
        ) as BBox;
        const refs = objectRefs(entry.object);
        const record = encodeObjectRecord({
          id: item.id,
          seq: coveredSeq,
          bbox,
          refs,
          deleted: false,
          full: true,
          groups: stateToGroups(entry.object.properties),
          body: entry.object.body ? compactBody(entry.object.body) : new Uint8Array(0),
        });
        folded.push({
          id: item.id,
          hash: idHash(item.id),
          refHashes: refs.map(idHash),
          bbox,
          key: item.key,
          length: record.length,
        });
        yield record;
      }
    }
  }
  await putBlobStream(s, foldKey, fold());

  // 4. Output order: unchanged records by their stored key, then the fold, merged.
  const refHashesByOffset = new Map<number, bigint[]>();
  for (let i = 0; i < base.refs.offsets.length; i++) {
    const offset = base.refs.offsets[i];
    refHashesByOffset.set(offset, [
      ...(refHashesByOffset.get(offset) ?? []),
      base.refs.hashes[i],
    ]);
  }
  type Planned = BaseEntry & { source: "base" | "fold"; offset: number };
  const unchanged: Planned[] = [];
  for (let leaf = 0; leaf < base.tree.offsets.length; leaf++) {
    const offset = base.tree.offsets[leaf];
    if (removedBaseOffsets.has(offset)) continue;
    const boxes = base.tree.levels[0];
    unchanged.push({
      source: "base",
      offset,
      hash: base.hashByOffset.get(offset) as bigint,
      refHashes: refHashesByOffset.get(offset) ?? [],
      bbox: [
        boxes[leaf * 4],
        boxes[leaf * 4 + 1],
        boxes[leaf * 4 + 2],
        boxes[leaf * 4 + 3],
      ],
      key: base.tree.keys[leaf],
      length: baseRecordLength(base, offset),
    });
  }
  const plan: Planned[] = [];
  let u = 0;
  let f = 0;
  while (u < unchanged.length || f < folded.length) {
    if (
      f >= folded.length ||
      (u < unchanged.length && unchanged[u].key <= folded[f].key)
    ) {
      plan.push(unchanged[u++]);
    } else {
      plan.push({ ...folded[f++], source: "fold", offset: 0 });
    }
  }
  const bounds = plan.reduce<BBox | null>(
    (box, entry) => unionBBox(box, entry.bbox),
    null,
  );

  // 5. Stream the new base from two sequential reads.
  async function* records(): AsyncGenerator<Uint8Array> {
    const fromBase =
      base.tree.offsets.length > 0
        ? blobRecords(s, base.key, base.tree.offsets[0], base.size)
        : (async function* () {})();
    const fromFold = blobRecords(
      s,
      foldKey,
      0,
      folded.reduce((sum, entry) => sum + entry.length, 0),
    );
    for (const entry of plan) {
      if (entry.source === "fold") {
        const next = await fromFold.next();
        if (next.done) throw new Error("Canvas fold ended early");
        yield next.value.bytes;
        continue;
      }
      while (true) {
        const next = await fromBase.next();
        if (next.done) throw new Error("Canvas base ended early");
        if (next.value.offset === entry.offset) {
          yield next.value.bytes;
          break;
        }
      }
    }
  }
  const rewritten = await writeCanvasBase(
    s,
    newBaseKey(ws.documentId),
    { coveredSeq, bounds: bounds ?? [0, 0, 0, 0], entries: plan },
    records(),
  );

  // 6. Commit, conditional on the base being unchanged: a restore since discards this.
  if (!(await commitBaseKey(s, ws.documentId, base.key, rewritten.key))) return;
  if (ws.epoch !== epoch) return;
  ws.base = rewritten;
  ws.segments = ws.segments.filter((segment) => !coveredKeys.has(segment.key));
  let grown = rewritten.header.bounds;
  for (const [id, entry] of ws.map) {
    entry.locations = entry.locations.filter((l) => !(l.blob && coveredKeys.has(l.blob)));
    if (entry.locations.length === 0) {
      unlinkRefs(ws, entry.summary);
      ws.map.delete(id);
    } else if (!entry.summary.deleted) {
      grown = unionBBox(grown, entry.summary.bbox) as BBox;
    }
  }
  ws.bounds = grown;
}

function endpointsMissing(objects: ReadonlyMap<string, CanvasObject>): string[] {
  const missing = new Set<string>();
  for (const object of objects.values()) {
    for (const ref of objectRefs(object)) if (!objects.has(ref)) missing.add(ref);
  }
  return [...missing];
}

/**
 * Replaces the canvas with a revision's base: a copy whose covered `seq` is
 * the last one handed out, so every existing segment is covered. Starts a new
 * epoch; the caller broadcasts `CanvasReload`.
 */
export function restoreCanvasBase(
  ws: CanvasWorkingSet,
  revisionBaseKey: string,
): Promise<void> {
  const s = ws.store;
  // In the append queue, so no record is ordered between the copy and the new epoch.
  const run = ws.appending.then(async () => {
    const source = await readCanvasBase(s, revisionBaseKey);
    const key = newBaseKey(ws.documentId);
    const header = new ByteWriter();
    header.raw(preamble());
    header.raw(
      encodeRecord(
        RecordKind.header,
        encodeHeaderPayload({ ...source.header, coveredSeq: ws.seq }),
      ),
    );
    const rest = await s.platform.blobStore.readStream(s.spaceId, revisionBaseKey, {
      start: PREAMBLE_BYTES + HEADER_RECORD_BYTES,
      end: source.size - 1,
    });
    if (!rest) throw new Error(`Canvas base ${revisionBaseKey} is missing from storage`);
    async function* copy(): AsyncGenerator<Uint8Array> {
      yield header.finish();
      yield* rest as ReadableStream<Uint8Array>;
    }
    await putBlobStream(s, key, copy());
    if (!(await commitBaseKey(s, ws.documentId, ws.base.key, key))) {
      throw new Error("The canvas changed while it was being restored");
    }
    const fresh = await workingSetOver(
      s,
      ws.documentId,
      await readCanvasBase(s, key),
      await listSegments(s, ws.documentId),
    );
    Object.assign(ws, {
      epoch: fresh.epoch,
      seq: fresh.seq,
      base: fresh.base,
      bounds: fresh.bounds,
      segments: fresh.segments,
      pending: [],
      map: fresh.map,
      reverse: fresh.reverse,
    });
  });
  ws.appending = run.catch(() => undefined);
  return run;
}

/**
 * Deletes a canvas's garbage an hour after it became garbage: covered
 * segments, bases neither the row nor a revision names, finished folds.
 */
export async function collectCanvasGarbage(
  s: SpaceStore,
  documentId: string,
): Promise<number> {
  const current = await canvasBaseKey(s, documentId);
  const base = await readCanvasBase(s, current);
  const revisions = await many(
    s.db
      .select({ snapshot: revision.snapshot })
      .from(revision)
      .where(eq(revision.documentId, documentId)),
  );
  const named = new Set([
    current,
    ...revisions.map((row) => row.snapshot.toString("utf-8")),
  ]);
  const listed: { key: string; updatedAt: Date; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await s.platform.blobStore.list(s.spaceId, {
      prefix: canvasPrefix(documentId),
      cursor,
    });
    listed.push(...page.files);
    cursor = page.cursor;
  } while (cursor);
  const segments = listed.flatMap((file) => {
    const name = parseCanvasBlobKey(file.key);
    return name?.kind === "segment"
      ? [
          {
            key: file.key,
            firstSeq: name.firstSeq,
            lastSeq: name.lastSeq,
            size: file.size,
          },
        ]
      : [];
  });
  const live = new Set(
    liveSegments(segments, base.header.coveredSeq).map((segment) => segment.key),
  );
  const now = Date.now();
  let deleted = 0;
  for (const file of listed) {
    if (now - file.updatedAt.getTime() < GC_AGE_MS) continue;
    const name = parseCanvasBlobKey(file.key);
    const garbage =
      (name?.kind === "base" && !named.has(file.key)) ||
      name?.kind === "fold" ||
      (name?.kind === "segment" && !live.has(file.key));
    if (!garbage) continue;
    await s.platform.blobStore.delete(s.spaceId, file.key);
    deleted++;
  }
  return deleted;
}
