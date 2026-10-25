import { type Accessor, createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/** The user's nodes in the current space (`vektor agent serve`); `undefined` until loaded. */
export function useNodes(enabled: Accessor<boolean>) {
  const { currentSpaceId } = useSpace();
  const { data } = useQuery({
    queryKey: createMemo(() => ["nodes", currentSpaceId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No active space selected");
      return await api.nodes.list(spaceId);
    },
    enabled: createMemo(() => !!currentSpaceId() && enabled()),
  });
  return data;
}
