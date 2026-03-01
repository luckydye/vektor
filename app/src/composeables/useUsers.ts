import { computed, toValue, type MaybeRef } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "../api/client.ts";

export function useUser(id: MaybeRef<string | undefined>) {
  const {
    data,
    isPending: isLoading,
    error,
  } = useQuery({
    queryKey: computed(() => ["wiki_user", toValue(id)]),
    queryFn: async () => {
      const userId = toValue(id);
      if (!userId) {
        throw new Error("No user ID provided");
      }
      return await api.users.getById(userId);
    },
    enabled: computed(() => !!toValue(id)),
    staleTime: 5 * 60 * 1000,
  });

  return {
    user: data,
    isLoading,
    error,
  };
}
