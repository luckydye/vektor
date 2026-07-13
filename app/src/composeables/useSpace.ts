import { computed, inject, type Ref, ref } from "vue";
import { api, type Space } from "#api/client.ts";
import { useMutation, useQuery } from "./query.ts";

export function useSpace(activeSpaceIdOverride?: Ref<string | null>) {
  const activeSpaceId =
    activeSpaceIdOverride ?? inject<Ref<string | null>>("space:activeId", ref(null));

  const { data: spaces, isPending } = useQuery({
    queryKey: ["wiki_spaces"],
    queryFn: () => api.spaces.get(),
    initialData: () => api.spaces.getCached(),
    subscribe: (callback) => api.spaces.subscribeCached(callback),
  });

  const currentSpace = computed<Space | null>(() => {
    if (!spaces.value) return null;
    if (activeSpaceId.value) {
      return (
        spaces.value.find((s: Space) => s.id === activeSpaceId.value) ??
        spaces.value[0] ??
        null
      );
    }
    return spaces.value[0] ?? null;
  });

  const spaceNotFound = computed(
    () => !isPending.value && spaces.value !== undefined && currentSpace.value === null,
  );

  const createSpaceMutation = useMutation({
    mutationFn: async (params: {
      name: string;
      slug: string;
      preferences?: Record<string, string>;
    }) => {
      return await api.spaces.post(params);
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
  });

  const deleteSpaceMutation = useMutation({
    mutationFn: async (spaceId: string) => {
      await api.space.delete(spaceId);
      return spaceId;
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
