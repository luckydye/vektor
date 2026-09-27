import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
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
    queryKey: createMemo(() => ["wiki_documents", spaceId()]),
    queryFn: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return (await api.documents.get(spaceIdValue, { limit: 500 })).documents;
    },
    initialData: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) return undefined;
      return await api.documents.getCached(spaceIdValue);
    },
    subscribe: (callback) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) return () => {};
      return api.documents.subscribeCached(spaceIdValue, callback);
    },
    enabled: createMemo(() => !!spaceId()),
  });

  const documents = createMemo(() => data() ?? []);

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
