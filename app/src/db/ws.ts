import {
  type RealtimeEventInput,
  type RealtimeTopic,
  type RealtimeTopicEvent,
  toRealtimeTopicEvent,
} from "#utils/realtime.ts";

export interface RealtimeEventEnvelope {
  spaceId: string;
  topics: RealtimeTopic[];
  events: RealtimeTopicEvent[];
  timestamp: string;
}

const listeners = new Set<(event: RealtimeEventEnvelope) => void>();
const pendingEvents = new Map<string, Map<RealtimeTopic, RealtimeTopicEvent>>();
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 100;

function drainPendingEvents(): RealtimeEventEnvelope[] {
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

export function publishSyncEvents(events: RealtimeEventEnvelope[]) {
  for (const event of events) {
    for (const listener of listeners) {
      listener(event);
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
  for (const event of events) {
    const normalizedEvent = toRealtimeTopicEvent(event);
    pendingTopicEvents.set(normalizedEvent.topic, normalizedEvent);
  }
  pendingEvents.set(spaceId, pendingTopicEvents);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    flushSyncEvents();
    debounceTimer = null;
  }, DEBOUNCE_DELAY);
}
