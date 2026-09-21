import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export function usePinnedDocuments() {
  const { currentSpaceId } = useSpace();

  const {
    data: pinnedDocuments,
    isPending,
    refetch,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_pinned_documents", currentSpaceId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No space ID");
      return await api.documents.getPinned(spaceId);
    },
    enabled: createMemo(() => !!currentSpaceId()),
    staleTime: 1000 * 60 * 5,
  });

  useSync(
    currentSpaceId,
    [realtimeTopics.documentTree, realtimeTopics.properties],
    () => refetch(),
  );

  return {
    pinnedDocuments: createMemo(() => pinnedDocuments() ?? []),
    isLoading: isPending,
  };
}
