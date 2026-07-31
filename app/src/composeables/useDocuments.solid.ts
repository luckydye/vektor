import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useQuery } from "./query.solid.ts";
import { useSpace } from "./useSpace.solid.ts";
import { useSync } from "./useSync.solid.ts";

export function useDocuments() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_documents", spaceId()]),
    queryFn: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return await api.documents.get(spaceIdValue, { limit: 500 });
    },
    initialData: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) return undefined;
      return await api.documents.getCached(spaceIdValue, { limit: 500 });
    },
    subscribe: (callback) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) return () => {};
      return api.documents.subscribeCached(spaceIdValue, callback, { limit: 500 });
    },
    enabled: createMemo(() => !!spaceId()),
  });

  const documents = createMemo(() => data()?.documents ?? []);

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
