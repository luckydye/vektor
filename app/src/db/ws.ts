import type { RealtimeTopic } from "../utils/realtime.ts";

export interface RealtimeEventEnvelope {
  spaceId: string;
  topics: RealtimeTopic[];
  timestamp: string;
}

const listeners = new Set<(event: RealtimeEventEnvelope) => void>();
const pendingEvents = new Map<string, Set<RealtimeTopic>>();
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 100;

function flushSyncEvents() {
  if (pendingEvents.size === 0) {
    return;
  }

  const timestamp = new Date().toISOString();
  const events = [...pendingEvents.entries()].map(([spaceId, topics]) => ({
    spaceId,
    topics: [...topics],
    timestamp,
  }));

  pendingEvents.clear();

  for (const event of events) {
    for (const listener of listeners) {
      listener(event);
    }
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

export function sendSyncEvent(spaceId: string, ...topics: RealtimeTopic[]) {
  if (topics.length === 0) {
    return;
  }

  const pendingTopics = pendingEvents.get(spaceId) ?? new Set<RealtimeTopic>();
  for (const topic of topics) {
    pendingTopics.add(topic);
  }
  pendingEvents.set(spaceId, pendingTopics);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    flushSyncEvents();
    debounceTimer = null;
  }, DEBOUNCE_DELAY);
}
