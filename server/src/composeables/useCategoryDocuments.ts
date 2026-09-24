import { type Accessor, createMemo } from "solid-js";
import type { DocumentWithProperties } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export function useCategoryDocuments(categorySlugs: Accessor<string[]>) {
  const { currentSpaceId } = useSpace();

  const {
    data: documentsData,
    isFetching,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: createMemo(() => [
      "wiki_category_documents_batch",
      currentSpaceId(),
      [...categorySlugs()].sort(),
    ]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) {
        throw new Error("No space ID");
      }
      if (categorySlugs().length === 0) {
        return {};
      }

      return await api.documents.getByCategories(spaceId, categorySlugs());
    },
    initialData: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId || categorySlugs().length === 0) return {};
      return await api.documents.getByCategoriesCached(spaceId, categorySlugs());
    },
    subscribe: (callback) => {
      const spaceId = currentSpaceId();
      if (!spaceId || categorySlugs().length === 0) return () => {};
      return api.documents.subscribeByCategoriesCached(
        spaceId,
        categorySlugs(),
        callback,
      );
    },
    enabled: createMemo(() => !!currentSpaceId() && categorySlugs().length > 0),
    staleTime: 1000 * 60 * 5, // 5 minutes
    placeholderData: (prev) => prev,
  });

  // Ensure all expanded slugs exist in the returned map, even when empty.
  const documentsBySlug = createMemo(() => {
    const batchedDocuments = documentsData() || {};
    const map = new Map<string, DocumentWithProperties[]>();

    for (const slug of categorySlugs()) {
      map.set(slug, batchedDocuments[slug] || []);
    }

    return map;
  });

  const isLoading = createMemo(() => isPending());
  const hasError = createMemo(() => isError());

  const isSlugLoading = (slug: string) =>
    isFetching() && documentsData()?.[slug] === undefined;

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
    isSlugLoading,
    hasError,
    refetchAll: refetch,
  };
}
