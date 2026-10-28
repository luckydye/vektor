/**
 * Canvas rooms: who is joined, the order records are broadcast in, and when
 * the pending buffer is flushed (see docs/canvas-format.md, Writing and Live
 * protocol). Presence stays in the presence room of the same document.
 */

import type { BBox } from "#canvas/document/format/records.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  appendCanvasRecords,
  type CanvasWorkingSet,
  canvasWorkingSet,
  collectCanvasGarbage,
  compactCanvas,
  dropCanvasWorkingSet,
  FLUSH_BYTES,
  FLUSH_DELAY_MS,
  flushCanvas,
  openCanvasWorkingSetKeys,
  pendingBytes,
  restoreCanvasBase,
} from "#db/space/canvasStore.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { every } from "#utils/every.ts";
import {
  type CanvasFlushedPayload,
  type CanvasReloadPayload,
  encodeCanvasOps,
  type RealtimeSocket,
  WsMsgType,
  wsEncodeDocumentFrame,
} from "./protocol.ts";

export interface CanvasRoom {
  spaceId: string;
  documentId: string;
  clients: Set<RealtimeSocket>;
  /** Orders appends and their broadcasts, so every client sees records in `seq` order. */
  ordering: Promise<unknown>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Writes refused while the document is being made readonly. */
  writeBlocked: boolean;
  idleSince: number | null;
}

const canvasRooms = new Map<string, CanvasRoom>();

function roomKey(spaceId: string, documentId: string): string {
  return `${spaceId}:${documentId}`;
}

export function canvasRoom(spaceId: string, documentId: string): CanvasRoom {
  const key = roomKey(spaceId, documentId);
  let room = canvasRooms.get(key);
  if (!room) {
    room = {
      spaceId,
      documentId,
      clients: new Set(),
      ordering: Promise.resolve(),
      flushTimer: null,
      writeBlocked: false,
      idleSince: null,
    };
    canvasRooms.set(key, room);
  }
  return room;
}

export async function roomWorkingSet(
  platform: Platform,
  room: CanvasRoom,
): Promise<CanvasWorkingSet> {
  return canvasWorkingSet(await openSpaceStore(platform, room.spaceId), room.documentId);
}

function frame(room: CanvasRoom, type: WsMsgType, payload: Uint8Array): Uint8Array {
  return wsEncodeDocumentFrame(type, room.documentId, payload);
}

function jsonPayload(value: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function broadcast(room: CanvasRoom, data: Uint8Array): void {
  for (const client of room.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

export function canvasJoinedPayload(ws: CanvasWorkingSet) {
  return { epoch: ws.epoch, seq: ws.seq, bounds: ws.bounds };
}

/** Blocks or unblocks writes to an open room; returns the previous state. */
export function setCanvasRoomWriteBlocked(
  spaceId: string,
  documentId: string,
  blocked: boolean,
): boolean {
  const room = canvasRooms.get(roomKey(spaceId, documentId));
  if (!room) return false;
  const previous = room.writeBlocked;
  room.writeBlocked = blocked;
  return previous;
}

/**
 * Orders a frame's records and broadcasts them to every member, the sender
 * included, with its `opId`. Returns null for a frame from another epoch,
 * which gets no echo: its sender is about to reload.
 */
export function submitCanvasOps(
  platform: Platform,
  room: CanvasRoom,
  ops: { epoch: string | null; opId: string; records: Uint8Array[] },
): Promise<{ seq: number } | null> {
  const run = room.ordering.then(async () => {
    if (room.writeBlocked) throw new Error("Cannot edit readonly document");
    const ws = await roomWorkingSet(platform, room);
    if (ops.epoch !== null && ops.epoch !== ws.epoch) return null;
    const accepted = await appendCanvasRecords(ws, ops.records);
    broadcast(
      room,
      frame(
        room,
        WsMsgType.CanvasOps,
        encodeCanvasOps({ opId: ops.opId, records: accepted }),
      ),
    );
    scheduleFlush(platform, room, ws);
    return { seq: ws.seq };
  });
  room.ordering = run.catch(() => undefined);
  return run;
}

function scheduleFlush(platform: Platform, room: CanvasRoom, ws: CanvasWorkingSet): void {
  if (pendingBytes(ws) >= FLUSH_BYTES) {
    void flushCanvasRoom(platform, room);
    return;
  }
  if (room.flushTimer || ws.pending.length === 0) return;
  room.flushTimer = setTimeout(() => {
    room.flushTimer = null;
    void flushCanvasRoom(platform, room);
  }, FLUSH_DELAY_MS);
  room.flushTimer.unref?.();
}

/**
 * Writes the pending records as a segment and tells the room, then compacts.
 * A failed write keeps them pending and retries; resolves with the flushed
 * `seq` either way, so a caller can wait for its own records.
 */
export async function flushCanvasRoom(
  platform: Platform,
  room: CanvasRoom,
): Promise<number> {
  if (room.flushTimer) {
    clearTimeout(room.flushTimer);
    room.flushTimer = null;
  }
  const ws = await roomWorkingSet(platform, room);
  let flushed: { seq: number; bounds: BBox } | null;
  try {
    flushed = await flushCanvas(ws);
  } catch (error) {
    appLogger.warn("Failed to flush canvas records; retrying", {
      error,
      spaceId: room.spaceId,
      documentId: room.documentId,
    });
    room.flushTimer = setTimeout(() => {
      room.flushTimer = null;
      void flushCanvasRoom(platform, room);
    }, FLUSH_DELAY_MS);
    room.flushTimer.unref?.();
    throw error;
  }
  if (!flushed) return ws.pending.length > 0 ? ws.pending[0].seq - 1 : ws.seq;
  broadcast(
    room,
    frame(
      room,
      WsMsgType.CanvasFlushed,
      jsonPayload({
        seq: flushed.seq,
        bounds: flushed.bounds,
      } satisfies CanvasFlushedPayload),
    ),
  );
  void compactCanvas(ws).catch((error) => {
    appLogger.warn("Failed to compact canvas", {
      error,
      spaceId: room.spaceId,
      documentId: room.documentId,
    });
  });
  return flushed.seq;
}

/**
 * Resolves once a flush covers `seq`. Flushes queue behind each other, so one
 * started after `seq` was handed out covers it.
 */
export async function waitForCanvasFlush(
  platform: Platform,
  room: CanvasRoom,
  seq: number,
): Promise<void> {
  const flushed = await flushCanvasRoom(platform, room);
  if (flushed < seq) throw new Error(`Canvas flush stopped at ${flushed}, before ${seq}`);
}

/** Orders and flushes everything submitted so far, when the canvas is open. */
export async function settleCanvasRoom(
  platform: Platform,
  spaceId: string,
  documentId: string,
): Promise<void> {
  if (!openCanvasWorkingSetKeys().includes(roomKey(spaceId, documentId))) return;
  const room = canvasRoom(spaceId, documentId);
  await room.ordering;
  await flushCanvasRoom(platform, room);
}

/** Tells the room a restore replaced the document; clients drop everything and reload. */
export function broadcastCanvasReload(room: CanvasRoom, ws: CanvasWorkingSet): void {
  broadcast(
    room,
    frame(
      room,
      WsMsgType.CanvasReload,
      jsonPayload({ epoch: ws.epoch, seq: ws.seq } satisfies CanvasReloadPayload),
    ),
  );
}

/**
 * Replaces a canvas with a revision's base: the pending buffer is discarded,
 * a new epoch starts and the room reloads. Nothing is resent; edits built on
 * the replaced state are discarded deliberately.
 */
export async function restoreCanvasRevision(
  platform: Platform,
  spaceId: string,
  documentId: string,
  baseKey: string,
): Promise<void> {
  const room = canvasRoom(spaceId, documentId);
  const run = room.ordering.then(async () => {
    const ws = await roomWorkingSet(platform, room);
    await restoreCanvasBase(ws, baseKey);
    broadcastCanvasReload(room, ws);
  });
  room.ordering = run.catch(() => undefined);
  await run;
}

export function leaveCanvasRoom(
  platform: Platform,
  room: CanvasRoom,
  socket: RealtimeSocket,
): void {
  room.clients.delete(socket);
  if (room.clients.size > 0) return;
  room.idleSince = Date.now();
  void flushCanvasRoom(platform, room).catch(() => undefined);
}

const ROOM_GRACE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Flushes and evicts working sets no room member holds any more, then
 * collects their garbage. Working sets opened by a load alone are evicted too.
 */
export async function sweepCanvasRooms(
  platform: Platform,
  now = Date.now(),
): Promise<void> {
  for (const key of openCanvasWorkingSetKeys()) {
    const separator = key.indexOf(":");
    const spaceId = key.slice(0, separator);
    const documentId = key.slice(separator + 1);
    const room = canvasRoom(spaceId, documentId);
    if (room.clients.size > 0) {
      room.idleSince = null;
      continue;
    }
    room.idleSince ??= now;
    if (now - room.idleSince < ROOM_GRACE_MS) continue;
    try {
      const ws = await roomWorkingSet(platform, room);
      await flushCanvasRoom(platform, room);
      await ws.compacting;
      if (room.clients.size > 0 || ws.pending.length > 0) continue;
      dropCanvasWorkingSet(spaceId, documentId);
      canvasRooms.delete(key);
      await collectCanvasGarbage(ws.store, documentId);
    } catch (error) {
      appLogger.warn("Failed to evict a canvas working set", {
        error,
        spaceId,
        documentId,
      });
    }
  }
}

export function startCanvasRoomSweep(platform: Platform): () => void {
  let sweeping = false;
  return every(SWEEP_INTERVAL_MS, () => {
    // A slow pass must not overlap the next one: both would evict the same set.
    if (sweeping) return;
    sweeping = true;
    void sweepCanvasRooms(platform).finally(() => {
      sweeping = false;
    });
  });
}

/** Flushes every open canvas, before the server stops. */
export async function flushAllCanvasRooms(platform: Platform): Promise<void> {
  for (const key of openCanvasWorkingSetKeys()) {
    const separator = key.indexOf(":");
    const room = canvasRoom(key.slice(0, separator), key.slice(separator + 1));
    await flushCanvasRoom(platform, room).catch((error) => {
      appLogger.error("Failed to flush a canvas at shutdown", {
        error,
        spaceId: room.spaceId,
        documentId: room.documentId,
      });
    });
  }
}
