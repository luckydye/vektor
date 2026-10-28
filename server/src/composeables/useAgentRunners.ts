import { type Accessor, createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/** Where the user can run agents in the current space; `undefined` until loaded. */
export function useAgentRunners(enabled: Accessor<boolean>) {
  const { currentSpaceId } = useSpace();
  const { data } = useQuery({
    queryKey: createMemo(() => ["agent-runners", currentSpaceId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No active space selected");
      return await api.runners.forAgents(spaceId);
    },
    enabled: createMemo(() => !!currentSpaceId() && enabled()),
  });
  return data;
}
