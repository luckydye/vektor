import { computed, type Ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useSpace } from "./useSpace.ts";
import { api } from "../api/client.ts";
import type { DocumentWithProperties } from "../api/ApiClient.ts";
import { useSync } from "./useSync.ts";
import { realtimeTopics } from "../utils/realtime.ts";

export function useCategoryDocuments(categorySlugs: Ref<string[]>) {
  const { currentSpaceId } = useSpace();

  const {
    data: documentsData,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: computed(() => [
      "wiki_category_documents_batch",
      currentSpaceId.value,
      [...categorySlugs.value].sort(),
    ]),
    queryFn: async () => {
      if (!currentSpaceId.value) {
        throw new Error("No space ID");
      }
      if (categorySlugs.value.length === 0) {
        return {};
      }

      return await api.documents.getByCategories(
        currentSpaceId.value,
        categorySlugs.value,
      );
    },
    enabled: computed(() => !!currentSpaceId.value && categorySlugs.value.length > 0),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Ensure all expanded slugs exist in the returned map, even when empty.
  const documentsBySlug = computed(() => {
    const batchedDocuments = documentsData.value || {};
    const map = new Map<string, DocumentWithProperties[]>();

    for (const slug of categorySlugs.value) {
      map.set(slug, batchedDocuments[slug] || []);
    }

    return map;
  });

  const isLoading = computed(() => isPending.value);
  const hasError = computed(() => isError.value);

  // TODO: syncs are not scopped to documents,
  // one prop updates will send a sync event to all users anywhere in the space
  useSync(
    currentSpaceId,
    [
      realtimeTopics.documentTree,
      realtimeTopics.categoryDocuments,
      realtimeTopics.properties,
    ],
    (keys) => {
      if (
        keys.includes(realtimeTopics.documentTree) ||
        keys.includes(realtimeTopics.properties) ||
        keys.includes(realtimeTopics.categoryDocuments)
      ) {
        refetch();
      }
    },
  );

  return {
    documentsBySlug,
    isLoading,
    hasError,
    refetchAll: refetch,
  };
}
