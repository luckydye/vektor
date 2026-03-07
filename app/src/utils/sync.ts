import { watchEffect, type ComputedRef, type Ref } from "vue";
import { api } from "../api/client.ts";
import type { RealtimeEventMessage, RealtimeTopic } from "../utils/realtime.ts";
import type { Doc as YDoc } from "yjs";

export function useSync(
  spaceId: Ref<string | null> | ComputedRef<string | null>,
  topics: RealtimeTopic[] | (() => RealtimeTopic[]),
  callback: (keys: string[], event: RealtimeEventMessage) => void,
) {
  watchEffect((onCleanup) => {
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

// Returns a cleanup function that disconnects from the Y.js room.
export function joinYjsRoom(spaceId: string, documentId: string, ydoc: YDoc): () => void {
  return api.joinYjsRoom(spaceId, documentId, ydoc);
}
