import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useSpace } from "./useSpace.ts";
import { api } from "../api/client.ts";

export function useMembers() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: computed(() => ["wiki_members", spaceId.value]),
    queryFn: async () => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      return await api.spaceMembers.get(spaceId.value);
    },
    enabled: computed(() => !!spaceId.value),
  });

  const members = computed(() => data.value || []);

  return {
    members,
    isLoading,
    error,
    refresh,
  };
}
