import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useSpace } from "./useSpace.ts";
import { api } from "../api/client.ts";

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
      return await api.documents.get(spaceId.value);
    },
    enabled: computed(() => !!spaceId.value),
  });

  const documents = computed(() => data.value?.documents || []);

  return {
    documents,
    isLoading,
    error,
    refresh,
  };
}
