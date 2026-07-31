import { type Accessor, createEffect, onCleanup } from "solid-js";
import { api } from "#api/client.ts";
import type { RealtimeEventMessage, RealtimeTopic } from "#realtime/protocol.ts";

/**
 * Subscribes to realtime topics for a space, re-subscribing when it changes.
 */
export function useSync(
  spaceId: Accessor<string | null>,
  topics: RealtimeTopic[] | (() => RealtimeTopic[]),
  callback: (keys: string[], event: RealtimeEventMessage) => void,
): void {
  createEffect(() => {
    if (typeof window === "undefined") return;

    const id = spaceId();
    if (!id) return;

    const resolvedTopics = typeof topics === "function" ? topics() : topics;
    const unsubscribe = api.subscribeToTopics(id, resolvedTopics, (event) => {
      callback(event.topics, event);
    });
    onCleanup(unsubscribe);
  });
}
