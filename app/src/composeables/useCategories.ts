import { computed, watch } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { useSpace } from "./useSpace.ts";
import { api, type Category } from "../api/client.ts";

export function useCategories() {
  const { currentSpaceId: spaceId } = useSpace();
  const queryClient = useQueryClient();

  const {
    data: categoriesData,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: computed(() => ["wiki_categories", spaceId.value]),
    queryFn: async () => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      return await api.categories.get(spaceId.value);
    },
    enabled: computed(() => !!spaceId.value),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const categories = computed(() => categoriesData.value || []);

  const createCategoryMutation = useMutation({
    mutationFn: async (params: {
      name: string;
      slug: string;
      description?: string;
      color?: string;
      icon?: string;
    }) => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      return await api.categories.post(spaceId.value, params);
    },
    onSuccess: (newCategory) => {
      queryClient.setQueryData(
        ["wiki_categories", spaceId.value],
        (old: Category[] | undefined) => {
          return old ? [...old, newCategory] : [newCategory];
        },
      );
    },
  });

  const updateCategoryMutation = useMutation({
    mutationFn: async (params: {
      categoryId: string;
      name: string;
      slug: string;
      description?: string;
      color?: string;
      icon?: string;
    }) => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      const { categoryId, ...rest } = params;
      return await api.category.put(spaceId.value, categoryId, rest);
    },
    onSuccess: (updatedCategory, variables) => {
      queryClient.setQueryData(
        ["wiki_categories", spaceId.value],
        (old: Category[] | undefined) => {
          if (!old) return [updatedCategory];
          return old.map((c) => (c.id === variables.categoryId ? updatedCategory : c));
        },
      );
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (categoryId: string) => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      await api.category.delete(spaceId.value, categoryId);
      return categoryId;
    },
    onSuccess: (categoryId) => {
      queryClient.setQueryData(
        ["wiki_categories", spaceId.value],
        (old: Category[] | undefined) => {
          if (!old) return [];
          return old.filter((c) => c.id !== categoryId);
        },
      );
    },
  });

  const createCategory = async (
    name: string,
    slug: string,
    description?: string,
    color?: string,
    icon?: string,
  ) => {
    return await createCategoryMutation.mutateAsync({
      name,
      slug,
      description,
      color,
      icon,
    });
  };

  const updateCategory = async (
    categoryId: string,
    name: string,
    slug: string,
    description?: string,
    color?: string,
    icon?: string,
  ) => {
    return await updateCategoryMutation.mutateAsync({
      categoryId,
      name,
      slug,
      description,
      color,
      icon,
    });
  };

  const deleteCategory = async (categoryId: string) => {
    await deleteCategoryMutation.mutateAsync(categoryId);
  };

  const reorderCategoryMutation = useMutation({
    mutationFn: async (categoryIds: string[]) => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      return await api.categories.reorder(spaceId.value, categoryIds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["wiki_categories", spaceId.value],
      });
    },
  });

  const reorderCategories = async (categoryIds: string[]) => {
    await reorderCategoryMutation.mutateAsync(categoryIds);
  };

  const getCategoryById = (categoryId: string): Category | undefined => {
    return categories.value.find((c) => c.id === categoryId);
  };

  const getCategoryBySlug = (slug: string): Category | undefined => {
    return categories.value.find((c) => c.slug === slug);
  };

  return {
    categories,
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
