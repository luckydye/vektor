/**
 * In-process fan-out for realtime topic events: DB writes call `sendSyncEvent`,
 * which coalesces per space over a short debounce window, and every connection's
 * `TopicSubscriptions` subscribes to push them to the client.
 */

import { publishAuthorizationChange } from "#acl/events.ts";
import { appendSyncEnvelope } from "./changeLog.ts";
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

const listeners = new Set<(event: RealtimeEventEnvelope) => void>();
/**
 * Coalesced and flushed per space, so a flush never carries another space's
 * events: a process may host several spaces that must not share I/O.
 */
const pendingEvents = new Map<string, Map<RealtimeTopic, RealtimeTopicEvent>>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_DELAY = 100;

function flushSyncEvents(spaceId: string) {
  debounceTimers.delete(spaceId);
  const topicEvents = pendingEvents.get(spaceId);
  if (!topicEvents) return;
  pendingEvents.delete(spaceId);

  const events = [...topicEvents.values()];
  // Numbered here so every route reaching `sendSyncEvent` is recorded without
  // having to know about the log.
  const envelope: RealtimeEventEnvelope = {
    spaceId,
    topics: [...topicEvents.keys()],
    events,
    timestamp: new Date().toISOString(),
    ...appendSyncEnvelope(spaceId, events),
  };
  for (const listener of listeners) {
    listener(envelope);
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

  clearTimeout(debounceTimers.get(spaceId));
  debounceTimers.set(
    spaceId,
    setTimeout(() => flushSyncEvents(spaceId), DEBOUNCE_DELAY),
  );
}
