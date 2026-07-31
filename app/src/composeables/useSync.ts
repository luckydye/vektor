import { type Accessor, createEffect, onCleanup } from "solid-js";
import { api } from "#api/client.ts";
import type { RealtimeEventMessage, RealtimeTopic } from "#realtime/protocol.ts";

/**
 * Subscribes to realtime topics for a space, re-subscribing when it changes.
 *
 * Vue's `watchEffect((onCleanup) => …)` took its cleanup as a callback
 * argument; Solid's `onCleanup` is called from inside the effect and runs
 * before the next execution as well as on disposal, which is the same
 * behaviour.
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
