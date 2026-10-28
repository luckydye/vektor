/**
 * Keeps a client's object store in step with the server (see
 * docs/canvas-format.md, Loading, Live protocol, Durability and Client
 * state): the region loader, live records, kept records, catching up and
 * resending after a reconnect, and summary corrections on echo.
 */

import { objectDeleted, objectRefs } from "#canvas/document/format/object.ts";
import {
  type BBox,
  decodeCursorPayload,
  decodeObjectPayload,
  encodeObjectRecord,
  type ObjectRecord,
  RecordKind,
  recordPayload,
} from "#canvas/document/format/records.ts";
import { streamRecords } from "#canvas/document/format/stream.ts";
import type { CanvasObjectStore } from "#canvas/document/objectStore.ts";

export interface CanvasJoined {
  epoch: string;
  seq: number;
  bounds: BBox;
}

/** The network a sync runs over; the app's realtime client supplies it. */
export interface CanvasTransport {
  /** Joins the room; `joined` fires on every (re)join, live frames in socket order. */
  join(handlers: {
    joined(payload: CanvasJoined): void;
    ops(opId: string, records: Uint8Array[]): void;
    flushed(payload: { seq: number; bounds: BBox }): void;
    reload(payload: { epoch: string; seq: number }): void;
    error(error: Error): void;
  }): { send(epoch: string, opId: string, records: Uint8Array[]): void; leave(): void };
  /** A load query; rejects with `CanvasCatchUpRefused` for a `since` the server cannot answer. */
  load(query: {
    view?: BBox;
    ids?: string[];
    since?: number;
    epoch?: string;
  }): Promise<ReadableStream<Uint8Array>>;
}

export class CanvasCatchUpRefused extends Error {}

/** Load this much beyond the viewport, as a fraction of its size. */
const REGION_PADDING = 0.5;
/** Evict objects beyond this multiple of the viewport. */
const EVICTION_SPAN = 3;

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function contains(outer: BBox, inner: BBox): boolean {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}

/** `rect` scaled by `factor` about its centre. */
function expand(rect: BBox, factor: number): BBox {
  const dx = ((rect[2] - rect[0]) * (factor - 1)) / 2;
  const dy = ((rect[3] - rect[1]) * (factor - 1)) / 2;
  return [rect[0] - dx, rect[1] - dy, rect[2] + dx, rect[3] + dy];
}

/** `rect` minus `hole`, as up to four rects. */
function subtract(rect: BBox, hole: BBox): BBox[] {
  if (!intersects(rect, hole)) return [rect];
  const pieces: BBox[] = [];
  if (hole[1] > rect[1]) pieces.push([rect[0], rect[1], rect[2], hole[1]]);
  if (hole[3] < rect[3]) pieces.push([rect[0], hole[3], rect[2], rect[3]]);
  const top = Math.max(rect[1], hole[1]);
  const bottom = Math.min(rect[3], hole[3]);
  if (hole[0] > rect[0]) pieces.push([rect[0], top, hole[0], bottom]);
  if (hole[2] < rect[2]) pieces.push([hole[2], top, rect[2], bottom]);
  return pieces.filter((piece) => piece[2] > piece[0] && piece[3] > piece[1]);
}

function intersection(a: BBox, b: BBox): BBox | null {
  const box: BBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

interface SentRecord {
  record: ObjectRecord;
  bytes: Uint8Array;
  /** The `seq` its echo carried, once it came. */
  seq: number | null;
}

interface SentFrame {
  opId: string;
  records: SentRecord[];
}

export interface CanvasSyncOptions {
  transport: CanvasTransport;
  store: CanvasObjectStore;
  /** Ids that must survive eviction: selected or being edited. */
  pinned(): ReadonlySet<string>;
  bounds(id: string): BBox | null;
  onBounds(bounds: BBox): void;
  onReload(): void;
  onError(error: Error): void;
}

export type CanvasSync = ReturnType<typeof createCanvasSync>;

export function createCanvasSync(options: CanvasSyncOptions) {
  const { transport, store } = options;
  let epoch: string | null = null;
  let receivedSeq = 0;
  let viewport: BBox | null = null;
  let loadedRects: BBox[] = [];
  let requestCounter = 0;
  const outstanding = new Set<number>();
  /** Live records for objects not held, kept while a request is outstanding. */
  let kept: { record: ObjectRecord; waiting: Set<number> }[] = [];
  /** Reached only as an endpoint: reloaded with `ids` before it is edited. */
  const partial = new Set<string>();
  let resend: SentFrame[] = [];
  /** Bodies with updates, own or applied, no flush covers yet: id → highest `seq` (∞ while unsent). */
  const bodyResend = new Map<string, number>();
  /** The `seq` of the latest record seen per object, and its summary bbox. */
  const lastSummary = new Map<string, { seq: number; bbox: BBox }>();
  let joinedOnce = false;
  let destroyed = false;

  const room = transport.join({
    joined: (payload) => void onJoined(payload).catch(options.onError),
    ops: onOps,
    flushed: onFlushed,
    reload: (payload) => void onReload(payload).catch(options.onError),
    error: options.onError,
  });

  function held(id: string): boolean {
    return store.objects.has(id);
  }

  function inRegion(bbox: BBox): boolean {
    return loadedRects.some((rect) => intersects(rect, bbox));
  }

  function noteSummary(record: ObjectRecord): void {
    const last = lastSummary.get(record.id);
    if (!last || record.seq >= last.seq)
      lastSummary.set(record.id, { seq: record.seq, bbox: record.bbox });
  }

  async function onJoined(payload: CanvasJoined): Promise<void> {
    options.onBounds(payload.bounds);
    if (!joinedOnce) {
      joinedOnce = true;
      epoch = payload.epoch;
      receivedSeq = payload.seq;
      if (viewport) setViewport(viewport);
      return;
    }
    // A reconnect: catch up on what the socket missed, then resend.
    try {
      await consume(
        await transport.load({ since: receivedSeq, epoch: epoch as string }),
        "live",
      );
    } catch (error) {
      if (!(error instanceof CanvasCatchUpRefused)) throw error;
      await resync(payload.epoch);
    }
    epoch = payload.epoch;
    receivedSeq = Math.max(receivedSeq, payload.seq);
    resendAll();
  }

  /** Loads every held object, deleted ones included, and the loaded region again. */
  async function resync(nextEpoch: string): Promise<void> {
    epoch = nextEpoch;
    const ids = [...store.objects.keys()];
    const loads = [
      ids.length > 0 ? request({ ids }) : null,
      ...loadedRects.map((view) => request({ view })),
    ];
    await Promise.all(loads);
  }

  function resendAll(): void {
    const frames = resend;
    resend = [];
    for (const frame of frames) {
      sendRecords(frame.records.map((sent) => sent.record));
    }
    const bodies = [...bodyResend.keys()].filter((id) => held(id));
    if (bodies.length > 0) {
      // Whole bodies: an update can depend on another client's that only this one still holds.
      sendRecords(
        bodies.map((id) => {
          const object = store.objects.get(id);
          return { ...store.summaryRecord(id), body: object?.body ?? new Uint8Array(0) };
        }),
      );
    }
  }

  function onOps(opId: string, records: Uint8Array[]): void {
    const own = resend.find((frame) => frame.opId === opId);
    const decoded = records.map((bytes) => decodeObjectPayload(recordPayload(bytes)));
    for (const record of decoded) receivedSeq = Math.max(receivedSeq, record.seq);
    if (own) {
      const echoed = new Set(decoded.map((record) => record.id));
      // Records missing from the echo were dropped; resending would not help.
      own.records = own.records.filter((sent) => echoed.has(sent.record.id));
      for (const sent of own.records) {
        sent.seq = decoded.find((record) => record.id === sent.record.id)?.seq ?? null;
      }
      if (own.records.length === 0) resend = resend.filter((frame) => frame !== own);
    }
    applyLive(decoded);
    if (own) for (const record of decoded) correctOnEcho(record);
  }

  function applyLive(records: ObjectRecord[]): void {
    const apply: ObjectRecord[] = [];
    const fetch: string[] = [];
    for (const record of records) {
      noteSummary(record);
      if (record.body.length > 0)
        bodyResend.set(record.id, Math.max(bodyResend.get(record.id) ?? 0, record.seq));
      if (held(record.id)) {
        apply.push(record);
        continue;
      }
      const relevant =
        record.refs.some((ref) => held(ref)) ||
        (!record.deleted && inRegion(record.bbox));
      if (relevant && record.full) {
        apply.push(record);
        continue;
      }
      if (relevant) {
        fetch.push(record.id);
        kept.push({ record, waiting: new Set([...outstanding, requestCounter + 1]) });
        continue;
      }
      if (outstanding.size > 0) kept.push({ record, waiting: new Set(outstanding) });
    }
    if (apply.length > 0) store.applyRemote(apply);
    if (fetch.length > 0) void request({ ids: fetch }).catch(options.onError);
  }

  /**
   * After the echo of its own record the client holds the object's state at
   * that `seq`, unless a later own record is still on its way; a summary that
   * no longer covers it gets one correction.
   */
  function correctOnEcho(record: ObjectRecord): void {
    const later = resend.some((frame) =>
      frame.records.some((sent) => sent.record.id === record.id && sent.seq === null),
    );
    if (later || !held(record.id)) return;
    const object = store.objects.get(record.id);
    if (!object) return;
    const bbox = options.bounds(record.id);
    const refs = objectRefs(object);
    const stale =
      (bbox !== null && !objectDeleted(object) && !contains(record.bbox, bbox)) ||
      refs.join("\u0000") !== record.refs.join("\u0000") ||
      objectDeleted(object) !== record.deleted;
    if (stale) sendRecords([store.summaryRecord(record.id)]);
  }

  function onFlushed(payload: { seq: number; bounds: BBox }): void {
    options.onBounds(payload.bounds);
    for (const frame of resend) {
      frame.records = frame.records.filter(
        (sent) => sent.seq === null || sent.seq > payload.seq,
      );
    }
    resend = resend.filter((frame) => frame.records.length > 0);
    for (const [id, seq] of bodyResend) if (seq <= payload.seq) bodyResend.delete(id);
  }

  async function onReload(payload: { epoch: string; seq: number }): Promise<void> {
    // The restore replaced the document; edits built on the old state are discarded.
    epoch = payload.epoch;
    receivedSeq = payload.seq;
    resend = [];
    bodyResend.clear();
    kept = [];
    partial.clear();
    lastSummary.clear();
    loadedRects = [];
    store.clear();
    options.onReload();
    if (viewport) setViewport(viewport);
  }

  /** Sends the records of a local transaction, in one frame. */
  function sendRecords(records: ObjectRecord[]): void {
    if (records.length === 0) return;
    const opId = crypto.randomUUID();
    const sent = records.map((record) => ({
      record,
      bytes: encodeObjectRecord(record),
      seq: null,
    }));
    resend.push({ opId, records: sent });
    for (const record of records) {
      if (record.body.length > 0) bodyResend.set(record.id, Number.POSITIVE_INFINITY);
    }
    // Before the first join the frame waits in the resend buffer.
    if (epoch !== null)
      room.send(
        epoch,
        opId,
        sent.map((entry) => entry.bytes),
      );
  }

  async function consume(
    stream: ReadableStream<Uint8Array>,
    mode: "live" | "load",
  ): Promise<ObjectRecord[]> {
    const records: ObjectRecord[] = [];
    let cursor: string | null = null;
    for await (const raw of streamRecords(stream, { preamble: true })) {
      if (raw.kind === RecordKind.cursor) {
        cursor = decodeCursorPayload(raw.payload);
        continue;
      }
      if (raw.kind !== RecordKind.object) continue;
      records.push(decodeObjectPayload(raw.payload));
    }
    if (mode === "load" && cursor !== epoch) throw new CanvasEpochChanged();
    for (const record of records) noteSummary(record);
    if (mode === "live") {
      applyLive(records);
      return records;
    }
    // A summary-only delete answers an id a base rewrite dropped: a client that
    // still shows the object drops it too.
    const gone = (record: ObjectRecord) =>
      record.deleted && record.groups.length === 0 && record.body.length === 0;
    const dropped = records.filter((record) => {
      const object = store.objects.get(record.id);
      return gone(record) && object !== undefined && !objectDeleted(object);
    });
    store.applyRemote(records.filter((record) => !gone(record)));
    if (dropped.length > 0) store.evict(dropped.map((record) => record.id));
    return records;
  }

  /** One load; a response from another epoch is retried. */
  async function request(query: { view?: BBox; ids?: string[] }): Promise<void> {
    const id = ++requestCounter;
    outstanding.add(id);
    try {
      let records: ObjectRecord[] | null = null;
      // A response read from another epoch is discarded; the next join brings the new one.
      for (let attempt = 0; records === null; attempt++) {
        try {
          records = await consume(await transport.load(query), "load");
        } catch (error) {
          if (!(error instanceof CanvasEpochChanged) || destroyed || attempt >= 2)
            throw error;
        }
      }
      markPartial(records, query);
      // Live records that arrived meanwhile merge after the response's older ones.
      const now = kept.filter((entry) => held(entry.record.id));
      kept = kept.filter((entry) => !held(entry.record.id));
      if (now.length > 0) store.applyRemote(now.map((entry) => entry.record));
    } finally {
      outstanding.delete(id);
      for (const entry of kept) entry.waiting.delete(id);
      kept = kept.filter((entry) => entry.waiting.size > 0);
    }
  }

  /**
   * An object neither matched by the query nor referencing one it returned
   * was reached only as an endpoint: the client may not hold what references it.
   */
  function markPartial(
    records: ObjectRecord[],
    query: { view?: BBox; ids?: string[] },
  ): void {
    const returned = new Set(records.map((record) => record.id));
    for (const record of records) {
      const matched =
        (!query.ids && !query.view) ||
        query.ids?.includes(record.id) ||
        (query.view && intersects(query.view, record.bbox)) ||
        record.refs.some((ref) => returned.has(ref));
      if (matched) partial.delete(record.id);
      else partial.add(record.id);
    }
  }

  /** Loads the part of `rect` no loaded rect covers. */
  function ensureRegion(rect: BBox): Promise<void> {
    if (epoch === null) return Promise.resolve();
    let missing = [rect];
    for (const loaded of loadedRects)
      missing = missing.flatMap((piece) => subtract(piece, loaded));
    // Counted as loaded from the moment it is requested.
    loadedRects.push(...missing);
    return Promise.all(missing.map((view) => request({ view }))).then(() => undefined);
  }

  /** Loads around the viewport, padded, and evicts what is far away. */
  function setViewport(rect: BBox): void {
    viewport = rect;
    if (epoch === null) return;
    void ensureRegion(expand(rect, 1 + REGION_PADDING)).catch(options.onError);
    evict(expand(rect, EVICTION_SPAN));
  }

  function evict(limit: BBox): void {
    const keep = new Set([
      ...options.pinned(),
      ...store.undoIds(),
      ...store.editingBodies(),
    ]);
    const far = (id: string) => {
      if (keep.has(id)) return false;
      const bbox = lastSummary.get(id)?.bbox ?? options.bounds(id);
      return !bbox || !intersects(bbox, limit);
    };
    // An object goes with what it references and what references it.
    const neighbours = new Map<string, string[]>();
    for (const object of store.objects.values()) {
      for (const ref of objectRefs(object)) {
        if (!held(ref)) continue;
        neighbours.set(object.id, [...(neighbours.get(object.id) ?? []), ref]);
        neighbours.set(ref, [...(neighbours.get(ref) ?? []), object.id]);
      }
    }
    const visited = new Set<string>();
    const evicted: string[] = [];
    for (const id of store.objects.keys()) {
      if (visited.has(id)) continue;
      const group: string[] = [];
      const stack = [id];
      visited.add(id);
      while (stack.length > 0) {
        const next = stack.pop() as string;
        group.push(next);
        for (const other of neighbours.get(next) ?? []) {
          if (!visited.has(other)) {
            visited.add(other);
            stack.push(other);
          }
        }
      }
      if (group.every(far)) evicted.push(...group);
    }
    if (evicted.length === 0) return;
    store.evict(evicted);
    for (const id of evicted) {
      partial.delete(id);
      lastSummary.delete(id);
    }
    loadedRects = loadedRects.flatMap((loaded) => {
      const kept = intersection(loaded, limit);
      return kept ? [kept] : [];
    });
  }

  /** Loads objects again with `ids`, bringing in what references them; for partial ones before an edit. */
  async function complete(ids: Iterable<string>): Promise<void> {
    const missing = [...ids].filter((id) => partial.has(id) || !held(id));
    if (missing.length > 0) await request({ ids: missing });
  }

  /** Every object, so a selection can cover the whole document. */
  function loadAll(): Promise<void> {
    return request({});
  }

  /**
   * Called with an object's laid-out extent: a summary bbox that does not
   * contain it gets a correction, which repairs bboxes computed without text layout.
   */
  function checkExtent(id: string, bbox: BBox): void {
    const last = lastSummary.get(id);
    if (!last || contains(last.bbox, bbox)) return;
    lastSummary.set(id, { seq: last.seq, bbox });
    sendRecords([store.summaryRecord(id)]);
  }

  function destroy(): void {
    destroyed = true;
    room.leave();
  }

  return {
    send: sendRecords,
    setViewport,
    ensureRegion,
    complete,
    loadAll,
    checkExtent,
    isPartial: (id: string) => partial.has(id),
    destroy,
  };
}

class CanvasEpochChanged extends Error {}
