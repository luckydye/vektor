import { watchEffect, type ComputedRef, type Ref } from "vue";
import { api } from "../api/client.ts";
import type { RealtimeTopic } from "../utils/realtime.ts";

export function useSync(
  spaceId: Ref<string | null> | ComputedRef<string | null>,
  topics: RealtimeTopic[] | (() => RealtimeTopic[]),
  callback: (keys: string[]) => void,
) {
  watchEffect(() => {
    if (!spaceId.value) {
      return () => {};
    }

    const resolvedTopics = typeof topics === "function" ? topics() : topics;
    return api.subscribeToTopics(spaceId.value, resolvedTopics, (event) => {
      callback(event.topics);
    });
  });
}
