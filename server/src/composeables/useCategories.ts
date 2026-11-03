import { createMemo } from "solid-js";
import { api, type Category } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useMutation, useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export type CategoryFields = Pick<
  Category,
  "name" | "slug" | "description" | "color" | "icon" | "documentSort" | "documentLimit"
>;

export function useCategories() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data: categoriesData,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_categories", spaceId()]),
    queryFn: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return await api.categories.get(spaceIdValue);
    },
    initialData: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) return undefined;
      return await api.categories.getCached(spaceIdValue);
    },
    subscribe: (callback) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) return () => {};
      return api.categories.subscribeCached(spaceIdValue, callback);
    },
    enabled: createMemo(() => !!spaceId()),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const categories = createMemo(() => categoriesData()?.categories || []);
  const hasHiddenCategories = createMemo(
    () => categoriesData()?.hasHiddenCategories ?? false,
  );

  const createCategoryMutation = useMutation({
    mutationFn: async (params: CategoryFields) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return await api.categories.post(spaceIdValue, params);
    },
  });

  const updateCategoryMutation = useMutation({
    mutationFn: async (params: CategoryFields & { categoryId: string }) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      const { categoryId, ...rest } = params;
      return await api.category.put(spaceIdValue, categoryId, rest);
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (categoryId: string) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      await api.category.delete(spaceIdValue, categoryId);
      return categoryId;
    },
  });

  const createCategory = async (fields: CategoryFields) =>
    await createCategoryMutation.mutateAsync(fields);

  /** Replaces every field: one left unset is cleared. */
  const updateCategory = async (categoryId: string, fields: CategoryFields) =>
    await updateCategoryMutation.mutateAsync({ categoryId, ...fields });

  const deleteCategory = async (categoryId: string) => {
    await deleteCategoryMutation.mutateAsync(categoryId);
  };

  const reorderCategoryMutation = useMutation({
    mutationFn: async (categoryIds: string[]) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return await api.categories.reorder(spaceIdValue, categoryIds);
    },
  });

  const reorderCategories = async (categoryIds: string[]) => {
    await reorderCategoryMutation.mutateAsync(categoryIds);
  };

  const getCategoryById = (categoryId: string): Category | undefined => {
    return categories().find((c) => c.id === categoryId);
  };

  const getCategoryBySlug = (slug: string): Category | undefined => {
    return categories().find((c) => c.slug === slug);
  };

  useSync(spaceId, [realtimeTopics.categories], (keys) => {
    if (keys.includes(realtimeTopics.categories)) {
      void refresh();
    }
  });

  return {
    categories,
    hasHiddenCategories,
    isLoading,
    error,
    refresh,
    createCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    getCategoryById,
    getCategoryBySlug,
  };
}
