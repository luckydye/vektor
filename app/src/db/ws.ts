import { config } from "../config.ts";
import {
  toRealtimeTopicEvent,
  type RealtimeEventInput,
  type RealtimeTopic,
  type RealtimeTopicEvent,
} from "../utils/realtime.ts";

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

async function flushSyncEvents() {
  const events = drainPendingEvents();
  if (events.length === 0) {
    return;
  }

  if (listeners.size > 0) {
    publishSyncEvents(events);
    return;
  }

  const appConfig = config();
  if (!appConfig.COLLABORATION_HOST) {
    return;
  }

  await fetch(
    `http${import.meta.env.DEV ? "" : "s"}://${appConfig.COLLABORATION_HOST}/sync`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(events),
    },
  ).catch((error) => {
    console.warn("Failed to relay realtime events:", error);
  });
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

  const pendingTopicEvents = pendingEvents.get(spaceId) ?? new Map<RealtimeTopic, RealtimeTopicEvent>();
  for (const event of events) {
    const normalizedEvent = toRealtimeTopicEvent(event);
    pendingTopicEvents.set(normalizedEvent.topic, normalizedEvent);
  }
  pendingEvents.set(spaceId, pendingTopicEvents);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    void flushSyncEvents();
    debounceTimer = null;
  }, DEBOUNCE_DELAY);
}
