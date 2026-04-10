import { watchEffect, type ComputedRef, type Ref } from "vue";
import { api } from "../api/client.ts";
import type { RealtimeEventMessage, RealtimeTopic } from "../utils/realtime.ts";

export function useSync(
  spaceId: Ref<string | null> | ComputedRef<string | null>,
  topics: RealtimeTopic[] | (() => RealtimeTopic[]),
  callback: (keys: string[], event: RealtimeEventMessage) => void,
) {
  watchEffect((onCleanup) => {
    if (typeof window === "undefined") {
      return;
    }

    if (!spaceId.value) {
      return;
    }

    const resolvedTopics = typeof topics === "function" ? topics() : topics;
    const unsub = api.subscribeToTopics(spaceId.value, resolvedTopics, (event) => {
      callback(event.topics, event);
    });
    onCleanup(unsub);
  });
}
