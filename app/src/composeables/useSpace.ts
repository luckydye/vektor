import { computed, ref, watchEffect, type ComputedRef, type Ref } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { api, type Space } from "../api/client.ts";
import { useRoute } from "./useRoute.ts";

const currentSpace = ref<Space | null>(null);

export function useSpace() {
  const { spaceSlug } = useRoute();
  const queryClient = useQueryClient();

  const {
    data: spaces,
    isPending,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: ["wiki_spaces"],
    queryFn: async () => {
      const data = await api.spaces.get();

      const spaceFromUrl = data.find((s: Space) => s.slug === spaceSlug.value);
      currentSpace.value = spaceFromUrl || data[0];

      return data;
    },
  });

  const createSpaceMutation = useMutation({
    mutationFn: async (params: {
      name: string;
      slug: string;
      preferences?: Record<string, string>;
    }) => {
      return await api.spaces.post(params);
    },
    onSuccess: (newSpace) => {
      queryClient.setQueryData(["wiki_spaces"], (old: Space[] | undefined) => {
        return old ? [...old, newSpace] : [newSpace];
      });
      currentSpace.value = newSpace;
    },
  });

  const updateSpaceMutation = useMutation({
    mutationFn: async (params: {
      spaceId: string;
      name: string;
      slug: string;
      preferences?: Record<string, string>;
    }) => {
      const { spaceId, ...rest } = params;
      return await api.space.patch(spaceId, rest);
    },
    onSuccess: (updatedSpace, variables) => {
      queryClient.setQueryData(["wiki_spaces"], (old: Space[] | undefined) => {
        if (!old) return [updatedSpace];
        return old.map((s) => (s.id === variables.spaceId ? updatedSpace : s));
      });

      if (currentSpace.value?.id === variables.spaceId) {
        currentSpace.value = updatedSpace;
      }
    },
  });

  const deleteSpaceMutation = useMutation({
    mutationFn: async (spaceId: string) => {
      await api.space.delete(spaceId);
      return spaceId;
    },
    onSuccess: (spaceId) => {
      queryClient.setQueryData(["wiki_spaces"], (old: Space[] | undefined) => {
        if (!old) return [];
        const filtered = old.filter((s) => s.id !== spaceId);

        if (currentSpace.value?.id === spaceId) {
          currentSpace.value = filtered[0] || null;
        }

        return filtered;
      });
    },
  });

  const createSpace = async (
    name: string,
    slug: string,
    preferences?: Record<string, string>,
  ) => {
    return await createSpaceMutation.mutateAsync({ name, slug, preferences });
  };

  const updateSpace = async (
    spaceId: string,
    name: string,
    slug: string,
    preferences?: Record<string, string>,
  ) => {
    return await updateSpaceMutation.mutateAsync({
      spaceId,
      name,
      slug,
      preferences,
    });
  };

  const deleteSpace = async (spaceId: string) => {
    await deleteSpaceMutation.mutateAsync(spaceId);
  };

  const setCurrentSpace = (space: Space) => {
    currentSpace.value = space;
  };

  const currentSpaceId = computed(() => currentSpace.value?.id || null);

  return {
    isLoading: isPending,
    currentSpace,
    currentSpaceId,
    spaces,
    createSpace,
    updateSpace,
    deleteSpace,
    setCurrentSpace,
  };
}
