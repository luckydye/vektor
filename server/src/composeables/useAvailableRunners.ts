import { type Accessor, createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/** The names of the runners and nodes the user may run jobs or agents on; `undefined` until loaded. */
export function useAvailableRunners(kind: "jobs" | "agents", enabled: Accessor<boolean>) {
  const { currentSpaceId } = useSpace();
  const { data } = useQuery({
    queryKey: createMemo(() => ["available-runners", kind, currentSpaceId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No active space selected");
      return await api.runners.available(spaceId, kind);
    },
    enabled: createMemo(() => !!currentSpaceId() && enabled()),
  });
  return data;
}
