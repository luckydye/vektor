/**
 * The recent event history of each space, so a reconnecting client can be told
 * what changed instead of being made to refetch everything it holds.
 *
 * Deliberately in memory. The rows are the durable truth and every client can
 * rebuild from them, so losing this history costs one resync and nothing else —
 * which is what a client gets today on every reconnect regardless. Nothing here
 * is a write-ahead log: it is written after the change it describes has
 * committed, and no recovery depends on it.
 */

import { randomUUID } from "node:crypto";
import type { RealtimeTopic, RealtimeTopicEvent, SyncCursor } from "./protocol.ts";

/**
 * Names this process's numbering, and travels with every sequence number.
 *
 * Sequence numbers restart from zero when the server does. A client holding
 * seq 500 from a previous process would otherwise accept the new 1..500 as
 * events it had already seen and never learn what it missed — a divergence
 * that reports no error and never heals.
 */
export const syncEpoch = randomUUID();

/** Envelopes of history one space keeps. Beyond this, a client resyncs. */
export const SYNC_HISTORY_LIMIT = 256;

/**
 * Spaces tracked at once. Evicting a space costs its clients a resync, exactly
 * as a restart does, so the least recently used one goes first.
 */
const SYNC_HISTORY_SPACES = 512;

interface SyncHistoryEntry {
  seq: number;
  events: RealtimeTopicEvent[];
}

interface SpaceHistory {
  /** Oldest first, and contiguous: `seq` only ever advances by one. */
  entries: SyncHistoryEntry[];
  nextSeq: number;
}

/** Insertion order is the LRU order; `historyFor` moves the space it touches last. */
const histories = new Map<string, SpaceHistory>();

/**
 * What a cursor is owed. `resync` means the answer cannot be expressed as a
 * list of events, because the history that would have held them is gone.
 */
export type SyncCatchUp =
  | { kind: "resync" }
  | { kind: "events"; seq: number; events: RealtimeTopicEvent[] };

/**
 * This space's history, created if absent.
 *
 * Reads create it too, which is what makes an absent history unambiguous: a
 * client is only ever handed a cursor for a space that has a record, so a
 * missing one means it was evicted and its holder has to resync. Were the
 * record created only on write, a cursor into a space that had published
 * nothing would be indistinguishable from one whose history had been dropped.
 */
function historyFor(spaceId: string): SpaceHistory {
  const existing = histories.get(spaceId);
  // Re-inserted to move this space to the end of the LRU order.
  if (existing) histories.delete(spaceId);
  const history = existing ?? { entries: [], nextSeq: 1 };
  histories.set(spaceId, history);

  while (histories.size > SYNC_HISTORY_SPACES) {
    const oldest = histories.keys().next();
    if (oldest.done || oldest.value === spaceId) break;
    histories.delete(oldest.value);
  }

  return history;
}

/** Record a published envelope, returning the sequence number it was given. */
export function appendSyncEnvelope(
  spaceId: string,
  events: RealtimeTopicEvent[],
): number {
  const history = historyFor(spaceId);
  const seq = history.nextSeq++;
  history.entries.push({ seq, events });
  if (history.entries.length > SYNC_HISTORY_LIMIT) {
    history.entries.splice(0, history.entries.length - SYNC_HISTORY_LIMIT);
  }
  return seq;
}

/**
 * The newest sequence number in a space, for a client that holds no cursor yet.
 *
 * Handed out on a first subscribe so that the *next* reconnect has a position
 * to catch up from. Without it a client that had simply never seen an event
 * would reconnect with nothing to compare, and quietly keep whatever it had
 * loaded before the socket dropped.
 */
export function headSyncSeq(spaceId: string): number {
  return historyFor(spaceId).nextSeq - 1;
}

/**
 * The events a cursor has not seen, narrowed to the topics it listens on.
 *
 * `isSubscribed` is supplied by the caller because which topics a connection
 * may hear about is an authorization question, and this module holds no
 * authority over it.
 */
export function catchUpSince(
  spaceId: string,
  cursor: SyncCursor,
  isSubscribed: (topic: RealtimeTopic) => boolean,
): SyncCatchUp {
  // A cursor from another process numbers a history this one never had.
  if (cursor.epoch !== syncEpoch) return { kind: "resync" };

  const history = histories.get(spaceId);
  // Absent means evicted: a cursor is only issued against a record, and both
  // issuing one and appending to it create the record.
  if (!history) return { kind: "resync" };

  const oldest = history.entries[0];
  // No entries at all: nothing has been published, so a cursor can only be at
  // the head already.
  if (!oldest) return { kind: "events", seq: history.nextSeq - 1, events: [] };
  // The client needs every entry after its cursor. If the first one it needs
  // has already been dropped, the gap cannot be described.
  if (oldest.seq > cursor.seq + 1) return { kind: "resync" };

  // Latest data per topic, matching what the live path delivers: events are
  // coalesced per topic before publication, so a topic named twice across the
  // range is one invalidation, carrying the most recent payload.
  const missed = new Map<RealtimeTopic, RealtimeTopicEvent>();
  for (const entry of history.entries) {
    if (entry.seq <= cursor.seq) continue;
    for (const event of entry.events) {
      if (!isSubscribed(event.topic)) continue;
      missed.set(event.topic, event);
    }
  }

  // The newest sequence number, not the newest that matched: an envelope
  // holding only topics this connection ignores is still read, and re-reading
  // it on every reconnect would grow without bound.
  return { kind: "events", seq: history.nextSeq - 1, events: [...missed.values()] };
}
