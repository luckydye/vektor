/**
 * Canvas blobs and base files (see docs/canvas-format.md, Storage and Base
 * file order): naming, coalesced range reads, reading a base's header and
 * tables, and streaming a new base out in two passes.
 */

import { objectBounds, unionBBox } from "#canvas/agent/objectBounds.ts";
import { bodyFromMarkdown } from "#canvas/document/bodyText.ts";
import { compareHilbert, hilbertKey } from "#canvas/document/format/hilbert.ts";
import {
  buildLookup,
  decodeLookup,
  encodeLookup,
  idHash,
  type LookupTable,
} from "#canvas/document/format/lookup.ts";
import {
  applyRecord,
  type CanvasObject,
  createObject,
  type FlattenedItem,
  flattenShape,
  flattenStroke,
  objectRefs,
  objectToRecord,
} from "#canvas/document/format/object.ts";
import { MIGRATION_WRITER } from "#canvas/document/format/properties.ts";
import {
  assertPreamble,
  type BaseHeader,
  type BBox,
  ByteWriter,
  decodeHeaderPayload,
  encodeHeaderPayload,
  encodeObjectRecord,
  encodeRecord,
  HEADER_RECORD_BYTES,
  PREAMBLE_BYTES,
  preamble,
  RecordKind,
  recordPayload,
} from "#canvas/document/format/records.ts";
import {
  buildRTree,
  decodeRTree,
  encodeRTree,
  type PackedRTree,
} from "#canvas/document/format/rtree.ts";
import type { SpaceStore } from "#db/client/store.ts";

/** Ranges closer than this are read as one. */
export const RANGE_GAP_BYTES = 16 * 1024;

export function canvasPrefix(documentId: string): string {
  return `documents/${documentId}/`;
}

export function newBaseKey(documentId: string): string {
  return `${canvasPrefix(documentId)}base-${crypto.randomUUID()}.vcanvas`;
}

export function segmentKey(
  documentId: string,
  firstSeq: number,
  lastSeq: number,
): string {
  return `${canvasPrefix(documentId)}seg-${firstSeq}-${lastSeq}.vcanvas`;
}

export function newFoldKey(documentId: string): string {
  return `${canvasPrefix(documentId)}fold-${crypto.randomUUID()}.vcanvas`;
}

export type CanvasBlobName =
  | { kind: "base" }
  | { kind: "fold" }
  | { kind: "segment"; firstSeq: number; lastSeq: number };

export function parseCanvasBlobKey(key: string): CanvasBlobName | null {
  const name = key.slice(key.lastIndexOf("/") + 1);
  if (/^base-[0-9a-f-]+\.vcanvas$/.test(name)) return { kind: "base" };
  if (/^fold-[0-9a-f-]+\.vcanvas$/.test(name)) return { kind: "fold" };
  const segment = /^seg-(\d+)-(\d+)\.vcanvas$/.exec(name);
  if (segment) {
    return { kind: "segment", firstSeq: Number(segment[1]), lastSeq: Number(segment[2]) };
  }
  return null;
}

/** Whether a row's `content_key` names a canvas base rather than spilled content. */
export function isCanvasBaseKey(key: string | null): key is string {
  return key !== null && parseCanvasBlobKey(key)?.kind === "base";
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Bytes `[start, end)` of a blob. */
export async function readBlobRange(
  s: SpaceStore,
  key: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (end <= start) return new Uint8Array(0);
  const stream = await s.platform.blobStore.readStream(s.spaceId, key, {
    start,
    end: end - 1,
  });
  if (!stream) throw new Error(`Canvas blob ${key} is missing from storage`);
  const bytes = await streamBytes(stream);
  if (bytes.length !== end - start) throw new Error(`Short read of canvas blob ${key}`);
  return bytes;
}

export interface Span {
  offset: number;
  length: number;
}

/**
 * The bytes of each span, read as few ranges: spans sorted by offset, gaps
 * under `RANGE_GAP_BYTES` read through.
 */
export async function readSpans(
  s: SpaceStore,
  key: string,
  spans: readonly Span[],
): Promise<Map<number, Uint8Array>> {
  const sorted = [...spans].sort((a, b) => a.offset - b.offset);
  const result = new Map<number, Uint8Array>();
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i].offset;
    let end = start + sorted[i].length;
    let j = i + 1;
    while (j < sorted.length && sorted[j].offset - end < RANGE_GAP_BYTES) {
      end = Math.max(end, sorted[j].offset + sorted[j].length);
      j++;
    }
    const bytes = await readBlobRange(s, key, start, end);
    for (let k = i; k < j; k++) {
      const span = sorted[k];
      result.set(
        span.offset,
        bytes.subarray(span.offset - start, span.offset - start + span.length),
      );
    }
    i = j;
  }
  return result;
}

export interface CanvasBase {
  key: string;
  size: number;
  header: BaseHeader;
  tree: PackedRTree;
  ids: LookupTable;
  refs: LookupTable;
  /** Record offset → id hash, the `ids` table inverted. */
  hashByOffset: Map<number, bigint>;
}

function invertIds(ids: LookupTable): Map<number, bigint> {
  const byOffset = new Map<number, bigint>();
  for (let i = 0; i < ids.offsets.length; i++)
    byOffset.set(ids.offsets[i], ids.hashes[i]);
  return byOffset;
}

/** Reads a base's header and its `index`, `ids` and `refs`, which the caller keeps. */
export async function readCanvasBase(s: SpaceStore, key: string): Promise<CanvasBase> {
  const info = await s.platform.blobStore.stat(s.spaceId, key);
  if (!info) throw new Error(`Canvas base ${key} is missing from storage`);
  const head = await readBlobRange(s, key, 0, PREAMBLE_BYTES + HEADER_RECORD_BYTES);
  assertPreamble(head);
  const headerRecord = head.subarray(PREAMBLE_BYTES);
  if (headerRecord[0] !== RecordKind.header)
    throw new Error(`Canvas base ${key} has no header`);
  const header = decodeHeaderPayload(recordPayload(headerRecord));
  const start = header.index.offset;
  const tables = await readBlobRange(
    s,
    key,
    start,
    header.refs.offset + header.refs.length,
  );
  const payloadAt = (span: { offset: number; length: number }) =>
    recordPayload(
      tables.subarray(span.offset - start, span.offset - start + span.length),
    );
  const ids = decodeLookup(payloadAt(header.ids));
  return {
    key,
    size: info.size,
    header,
    tree: decodeRTree(payloadAt(header.index)),
    ids,
    refs: decodeLookup(payloadAt(header.refs)),
    hashByOffset: invertIds(ids),
  };
}

/** Length of the base record at `offset`: up to the next record, or the end of the file. */
export function baseRecordLength(base: CanvasBase, offset: number): number {
  const offsets = base.tree.offsets;
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] <= offset) low = mid + 1;
    else high = mid;
  }
  if (offsets[low - 1] !== offset) throw new Error(`No base record at ${offset}`);
  return (low < offsets.length ? offsets[low] : base.size) - offset;
}

/** One object of a base as its tables see it, in output order. */
export interface BaseEntry {
  hash: bigint;
  refHashes: bigint[];
  bbox: BBox;
  key: bigint;
  length: number;
}

async function* withPrefix(
  head: Uint8Array,
  rest: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield head;
  yield* rest;
}

function toStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Streams `chunks` into a blob. */
export function putBlobStream(
  s: SpaceStore,
  key: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
  return s.platform.blobStore.putStream(s.spaceId, key, toStream(chunks));
}

/**
 * Streams a base out: header, index, ids, refs, then `records`, which must
 * yield one encoded `object` record per entry, in order, of the entry's length.
 */
export async function writeCanvasBase(
  s: SpaceStore,
  key: string,
  plan: { coveredSeq: number; bounds: BBox; entries: readonly BaseEntry[] },
  records: AsyncIterable<Uint8Array>,
): Promise<CanvasBase> {
  const encodedLength = (payloadLength: number) => {
    const writer = new ByteWriter();
    writer.varint(payloadLength);
    return 1 + writer.length + payloadLength;
  };
  // The tables' sizes follow from the counts, so object offsets are known before any is written.
  const placeholder = buildRTree(
    plan.entries.map((entry) => ({ bbox: entry.bbox, offset: 0, key: entry.key })),
  );
  const indexLength = encodedLength(encodeRTree(placeholder).length);
  const idsLength = encodedLength(4 + 16 * plan.entries.length);
  const refCount = plan.entries.reduce((sum, entry) => sum + entry.refHashes.length, 0);
  const refsLength = encodedLength(4 + 16 * refCount);
  const indexOffset = PREAMBLE_BYTES + HEADER_RECORD_BYTES;
  const idsOffset = indexOffset + indexLength;
  const refsOffset = idsOffset + idsLength;
  let offset = refsOffset + refsLength;
  const offsets = plan.entries.map((entry) => {
    const at = offset;
    offset += entry.length;
    return at;
  });
  const size = offset;

  const tree = buildRTree(
    plan.entries.map((entry, i) => ({
      bbox: entry.bbox,
      offset: offsets[i],
      key: entry.key,
    })),
  );
  const ids = buildLookup(
    plan.entries.map((entry, i) => ({ hash: entry.hash, offset: offsets[i] })),
  );
  const refs = buildLookup(
    plan.entries.flatMap((entry, i) =>
      entry.refHashes.map((hash) => ({ hash, offset: offsets[i] })),
    ),
  );
  const header: BaseHeader = {
    count: plan.entries.length,
    coveredSeq: plan.coveredSeq,
    bounds: plan.bounds,
    index: { offset: indexOffset, length: indexLength },
    ids: { offset: idsOffset, length: idsLength },
    refs: { offset: refsOffset, length: refsLength },
  };
  const head = new ByteWriter();
  head.raw(preamble());
  head.raw(encodeRecord(RecordKind.header, encodeHeaderPayload(header)));
  head.raw(encodeRecord(RecordKind.index, encodeRTree(tree)));
  head.raw(encodeRecord(RecordKind.ids, encodeLookup(ids)));
  head.raw(encodeRecord(RecordKind.refs, encodeLookup(refs)));
  if (head.length !== offsets[0] && plan.entries.length > 0) {
    throw new Error("Canvas base tables do not match their planned size");
  }

  async function* checked(): AsyncGenerator<Uint8Array> {
    let index = 0;
    for await (const record of records) {
      const entry = plan.entries[index];
      if (!entry || record.length !== entry.length) {
        throw new Error("Canvas base record does not match its plan");
      }
      index++;
      yield record;
    }
    if (index !== plan.entries.length) throw new Error("Canvas base is missing records");
  }

  await putBlobStream(s, key, withPrefix(head.finish(), checked()));
  return { key, size, header, tree, ids, refs, hashByOffset: invertIds(ids) };
}

/** Ids pinned while building a body twice; the client IDs of live edits are random. */
const SNAPSHOT_BODY_CLIENT = 1;

function objectFromItem(flat: FlattenedItem): CanvasObject {
  const object = createObject(flat.id);
  applyRecord(object, {
    groups: [{ counter: 1, writer: MIGRATION_WRITER, entries: flat.entries }],
    body:
      flat.text !== undefined
        ? bodyFromMarkdown(flat.text, SNAPSHOT_BODY_CLIENT)
        : new Uint8Array(0),
  });
  return object;
}

/**
 * Writes a snapshot JSON (`{ shapes, strokes }`) as a base, the one point the
 * server holds a whole canvas: the first pass keeps each record's id, bbox,
 * refs and length, the second builds every record again and streams it.
 */
export async function writeBaseFromSnapshot(
  s: SpaceStore,
  documentId: string,
  snapshot: { shapes?: unknown; strokes?: unknown },
  coveredSeq = 0,
): Promise<CanvasBase> {
  const items = (value: unknown) =>
    Array.isArray(value)
      ? (value as unknown[]).filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string",
        )
      : [];
  const shapes = items(snapshot.shapes);
  const strokes = items(snapshot.strokes);
  const shapeById = new Map(shapes.map((shape) => [shape.id as string, shape]));
  const lookup = (id: string) => {
    const shape = shapeById.get(id);
    return shape ? objectFromItem(flattenShape(shape)) : undefined;
  };
  const build = (index: number): CanvasObject => {
    if (index < shapes.length) return objectFromItem(flattenShape(shapes[index]));
    const stroke = strokes[index - shapes.length];
    // Strokes rendered in `updatedAt` order and had no `z`.
    return objectFromItem(
      flattenStroke({ ...stroke, z: stroke.z ?? stroke.updatedAt ?? 0 }),
    );
  };

  const table: {
    index: number;
    id: string;
    bbox: BBox;
    key: bigint;
    refs: string[];
    length: number;
  }[] = [];
  let bounds: BBox | null = null;
  const total = shapes.length + strokes.length;
  for (let index = 0; index < total; index++) {
    const object = build(index);
    const bbox = objectBounds(object, lookup) ?? [0, 0, 0, 0];
    bounds = unionBBox(bounds, bbox);
    table.push({
      index,
      id: object.id,
      bbox,
      key: hilbertKey(bbox),
      refs: objectRefs(object),
      length: encodeObjectRecord(objectToRecord(object, bbox, coveredSeq)).length,
    });
  }
  table.sort(compareHilbert);

  async function* records(): AsyncGenerator<Uint8Array> {
    for (const entry of table) {
      yield encodeObjectRecord(
        objectToRecord(build(entry.index), entry.bbox, coveredSeq),
      );
    }
  }

  return writeCanvasBase(
    s,
    newBaseKey(documentId),
    {
      coveredSeq,
      bounds: bounds ?? [0, 0, 0, 0],
      entries: table.map((entry) => ({
        hash: idHash(entry.id),
        refHashes: entry.refs.map(idHash),
        bbox: entry.bbox,
        key: entry.key,
        length: entry.length,
      })),
    },
    records(),
  );
}
