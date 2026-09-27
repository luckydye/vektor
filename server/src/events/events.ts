/**
 * The space event stream: the one way points get into a series, and an
 * in-process bus that hears every append once it is durable. No replay.
 */

import { config, positiveIntSetting } from "#config";
import type { SpaceStore } from "#db/client/store.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { matchesAll, type SeriesPredicate } from "#series/predicates.ts";
import { appendPoints } from "#series/store.ts";

export interface SpaceEvent {
  ts: number;
  series: string;
  type: string;
  documentId: string | null;
  fields: Record<string, number | string | boolean | null>;
}

interface Subscriber {
  spaceId: string;
  filter: SeriesPredicate[];
  onEvents: (events: readonly SpaceEvent[]) => void | Promise<void>;
  queue: SpaceEvent[];
  delivering: boolean;
}

const subscribers = new Set<Subscriber>();

function queueLimit(): number {
  return positiveIntSetting(
    "VEKTOR_EVENTS_SUBSCRIBER_QUEUE",
    config().EVENTS_SUBSCRIBER_QUEUE,
    10_000,
  );
}

/** Hand queued events over one batch at a time; a slow subscriber keeps queueing. */
async function deliver(subscriber: Subscriber): Promise<void> {
  if (subscriber.delivering) return;
  subscriber.delivering = true;
  try {
    while (subscriber.queue.length > 0 && subscribers.has(subscriber)) {
      const batch = Object.freeze(subscriber.queue.splice(0));
      await subscriber.onEvents(batch);
    }
  } finally {
    subscriber.delivering = false;
  }
}

/**
 * Listen to a space's appends that match every predicate. A subscriber that
 * falls more than `VEKTOR_EVENTS_SUBSCRIBER_QUEUE` events behind is dropped.
 */
export function subscribeToEvents(
  spaceId: string,
  filter: SeriesPredicate[],
  onEvents: (events: readonly SpaceEvent[]) => void | Promise<void>,
): () => void {
  const subscriber: Subscriber = {
    spaceId,
    filter,
    onEvents,
    queue: [],
    delivering: false,
  };
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

function publish(spaceId: string, events: SpaceEvent[]): void {
  const limit = queueLimit();
  for (const subscriber of subscribers) {
    if (subscriber.spaceId !== spaceId) continue;
    const matching = events.filter((event) => matchesAll(event, subscriber.filter));
    if (matching.length === 0) continue;
    subscriber.queue.push(...matching.map((event) => Object.freeze(event)));
    if (subscriber.queue.length > limit) {
      subscribers.delete(subscriber);
      continue;
    }
    void deliver(subscriber).catch(() => subscribers.delete(subscriber));
  }
}

/** Append points to a declared series, then tell the bus and realtime about them. */
export async function ingestPoints(
  store: SpaceStore,
  name: string,
  points: unknown[],
): Promise<{ latestTs: number; count: number }> {
  const appended = await appendPoints(store, name, points);
  const { series } = appended;

  publish(
    store.spaceId,
    appended.points.map((point) => ({
      ts: point.ts,
      series: series.name,
      type: point.type,
      documentId: series.documentId,
      fields: point.fields,
    })),
  );
  const data = {
    kind: "series",
    name: series.name,
    documentId: series.documentId,
    latestTs: appended.latestTs,
    count: appended.count,
  };
  sendSyncEvent(
    store.spaceId,
    { topic: realtimeTopics.series(series.name), data },
    { topic: realtimeTopics.spaceEvents, data },
  );
  return { latestTs: appended.latestTs, count: appended.count };
}
