import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

export function useMembers() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_members", spaceId()]),
    queryFn: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return await api.spaceMembers.get(spaceIdValue);
    },
    enabled: createMemo(() => !!spaceId()),
  });

  const members = createMemo(() => data() || []);

  return {
    members,
    isLoading,
    error,
    refresh,
  };
}
