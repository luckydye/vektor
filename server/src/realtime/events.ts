/**
 * In-process fan-out for realtime topic events: DB writes call `sendSyncEvent`,
 * which coalesces per space over a short debounce window, and every connection's
 * `TopicSubscriptions` subscribes to push them to the client.
 */

import { publishAuthorizationChange } from "#acl/events.ts";
import { appendSyncEnvelope, syncEpoch } from "./changeLog.ts";
import { documentLockChangedKind } from "./changes.ts";
import {
  type RealtimeEventInput,
  type RealtimeTopic,
  type RealtimeTopicEvent,
  realtimeTopics,
  toRealtimeTopicEvent,
} from "./protocol.ts";

export interface RealtimeEventEnvelope {
  spaceId: string;
  topics: RealtimeTopic[];
  events: RealtimeTopicEvent[];
  timestamp: string;
  /** Position in the space's history; see `changeLog.ts`. */
  seq: number;
  epoch: string;
}

/** An envelope before the change log gives it a position. */
type UnnumberedEnvelope = Omit<RealtimeEventEnvelope, "seq" | "epoch">;

const listeners = new Set<(event: RealtimeEventEnvelope) => void>();
const pendingEvents = new Map<string, Map<RealtimeTopic, RealtimeTopicEvent>>();
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 100;

function drainPendingEvents(): UnnumberedEnvelope[] {
  if (pendingEvents.size === 0) {
    return [];
  }

  const timestamp = new Date().toISOString();
  const events = [...pendingEvents.entries()].map(([spaceId, topicEvents]) => ({
    spaceId,
    topics: [...topicEvents.keys()],
    events: [...topicEvents.values()],
    timestamp,
  }));

  pendingEvents.clear();
  return events;
}

export function publishSyncEvents(events: UnnumberedEnvelope[]) {
  for (const event of events) {
    // Numbered here so every route reaching `sendSyncEvent` is recorded without
    // having to know about the log.
    const envelope: RealtimeEventEnvelope = {
      ...event,
      seq: appendSyncEnvelope(event.spaceId, event.events),
      epoch: syncEpoch,
    };
    for (const listener of listeners) {
      listener(envelope);
    }
  }
}

function flushSyncEvents() {
  const events = drainPendingEvents();
  if (events.length > 0) {
    publishSyncEvents(events);
  }
}

export function subscribeToSyncEvents(
  listener: (event: RealtimeEventEnvelope) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sendSyncEvent(spaceId: string, ...events: RealtimeEventInput[]) {
  if (events.length === 0) {
    return;
  }

  const pendingTopicEvents =
    pendingEvents.get(spaceId) ?? new Map<RealtimeTopic, RealtimeTopicEvent>();
  let authorizationChanged = false;
  for (const event of events) {
    const normalizedEvent = toRealtimeTopicEvent(event);
    authorizationChanged ||=
      normalizedEvent.topic === realtimeTopics.acl ||
      normalizedEvent.data?.kind === documentLockChangedKind;
    pendingTopicEvents.set(normalizedEvent.topic, normalizedEvent);
  }
  if (authorizationChanged) publishAuthorizationChange({ spaceId });
  pendingEvents.set(spaceId, pendingTopicEvents);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    flushSyncEvents();
    debounceTimer = null;
  }, DEBOUNCE_DELAY);
}
