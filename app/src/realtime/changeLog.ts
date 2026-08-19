/**
 * The recent event history of each space, so a reconnecting client can be told
 * what changed instead of refetching everything it holds. In memory on purpose:
 * the rows are the truth, so losing this costs one resync.
 */

import { randomUUID } from "node:crypto";
import type { RealtimeTopic, RealtimeTopicEvent, SyncCursor } from "./protocol.ts";

/**
 * Names this process's numbering. Sequence numbers restart at zero on boot, so
 * without it a client would read a new 1..500 as already seen.
 */
export const syncEpoch = randomUUID();

/** Envelopes of history one space keeps. Beyond this, a client resyncs. */
export const SYNC_HISTORY_LIMIT = 256;

const SYNC_HISTORY_SPACES = 512;

interface SpaceHistory {
  /** Oldest first, and contiguous: `seq` only ever advances by one. */
  entries: Array<{ seq: number; events: RealtimeTopicEvent[] }>;
  nextSeq: number;
}

/** Insertion order is the LRU order. */
const histories = new Map<string, SpaceHistory>();

export type SyncCatchUp =
  | { kind: "resync" }
  | { kind: "events"; seq: number; events: RealtimeTopicEvent[] };

/**
 * This space's history, created if absent. Reads create it too, which is what
 * makes an absent one unambiguous: a cursor is only issued against a record, so
 * a missing record means it was evicted and its holder has to resync.
 */
function historyFor(spaceId: string): SpaceHistory {
  const existing = histories.get(spaceId);
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
 * The newest sequence number, for a client that holds no cursor yet. Without
 * one, a client that had never seen an event would reconnect with nothing to
 * compare against.
 */
export function headSyncSeq(spaceId: string): number {
  return historyFor(spaceId).nextSeq - 1;
}

/**
 * The events a cursor has not seen. `isSubscribed` is the caller's: which
 * topics a connection may hear about is an authorization question.
 */
export function catchUpSince(
  spaceId: string,
  cursor: SyncCursor,
  isSubscribed: (topic: RealtimeTopic) => boolean,
): SyncCatchUp {
  if (cursor.epoch !== syncEpoch) return { kind: "resync" };

  const history = histories.get(spaceId);
  if (!history) return { kind: "resync" };

  const oldest = history.entries[0];
  if (!oldest) return { kind: "events", seq: history.nextSeq - 1, events: [] };
  // The first entry the client needs is gone, so the gap cannot be described.
  if (oldest.seq > cursor.seq + 1) return { kind: "resync" };

  // Latest data per topic, matching the live path, which coalesces the same way.
  const missed = new Map<RealtimeTopic, RealtimeTopicEvent>();
  for (const entry of history.entries) {
    if (entry.seq <= cursor.seq) continue;
    for (const event of entry.events) {
      if (!isSubscribed(event.topic)) continue;
      missed.set(event.topic, event);
    }
  }

  // The newest seq, not the newest that matched: an envelope of topics this
  // connection ignores is still read.
  return { kind: "events", seq: history.nextSeq - 1, events: [...missed.values()] };
}
