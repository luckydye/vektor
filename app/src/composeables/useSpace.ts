import { computed } from "vue";
import { api, type Space } from "../api/client.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useRoute } from "./useRoute.ts";

export function useSpace() {
  const { spaceSlug } = useRoute();
  const queryClient = useQueryClient();

  const { data: spaces, isPending } = useQuery({
    queryKey: ["wiki_spaces"],
    queryFn: () => api.spaces.get(),
  });

  const currentSpace = computed<Space | null>(() => {
    if (!spaces.value) return null;
    if (!spaceSlug.value) return spaces.value[0] ?? null;
    return spaces.value.find((s: Space) => s.slug === spaceSlug.value || s.id === spaceSlug.value) ?? null;
  });

  // True once the spaces list has loaded and the slug/id in the URL doesn't match any space.
  const spaceNotFound = computed(() =>
    !isPending.value && !!spaceSlug.value && spaces.value !== undefined && currentSpace.value === null,
  );

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
        return old.filter((s) => s.id !== spaceId);
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

  const currentSpaceId = computed(() => currentSpace.value?.id ?? null);

  return {
    isLoading: isPending,
    currentSpace,
    currentSpaceId,
    spaceNotFound,
    spaces,
    createSpace,
    updateSpace,
    deleteSpace,
  };
}
