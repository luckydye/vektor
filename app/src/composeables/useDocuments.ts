import { computed } from "vue";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export function useDocuments() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: computed(() => ["wiki_documents", spaceId.value]),
    queryFn: async () => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      return await api.documents.get(spaceId.value, { limit: 500 });
    },
    initialData: async () => {
      if (!spaceId.value) return undefined;
      return await api.documents.getCached(spaceId.value, { limit: 500 });
    },
    subscribe: (callback) => {
      if (!spaceId.value) return () => {};
      return api.documents.subscribeCached(spaceId.value, callback, { limit: 500 });
    },
    enabled: computed(() => !!spaceId.value),
  });

  const documents = computed(() => data.value?.documents ?? []);

  useSync(
    spaceId,
    [
      realtimeTopics.documents,
      realtimeTopics.documentTree,
      realtimeTopics.categoryDocuments,
      realtimeTopics.properties,
    ],
    () => {
      void refresh();
    },
  );

  return {
    documents,
    isLoading,
    error,
    refresh,
  };
}
