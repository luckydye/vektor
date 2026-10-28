import { type Accessor, createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/** The current space's runners and the user's nodes; both `undefined` until loaded. */
export function useRunners(enabled: Accessor<boolean>) {
  const { currentSpaceId } = useSpace();
  const queryClient = useQueryClient();
  const queryKey = createMemo(() => ["runners", currentSpaceId()]);
  const spaceId = () => {
    const id = currentSpaceId();
    if (!id) throw new Error("No active space selected");
    return id;
  };
  const { data } = useQuery({
    queryKey,
    queryFn: () => api.runners.list(spaceId()),
    enabled: createMemo(() => !!currentSpaceId() && enabled()),
  });
  return {
    runners: () => data()?.runners,
    nodes: () => data()?.nodes,
    /** Resolves with the runner's secret, which is not shown again. */
    async add(name: string, url: string) {
      const { secret } = await api.runners.create(spaceId(), { name, url });
      queryClient.invalidateQueries({ queryKey: queryKey() });
      return secret;
    },
    async describe(runnerId: string) {
      await api.runners.describe(spaceId(), runnerId);
      queryClient.invalidateQueries({ queryKey: queryKey() });
    },
    async remove(runnerId: string) {
      await api.runners.delete(spaceId(), runnerId);
      queryClient.invalidateQueries({ queryKey: queryKey() });
    },
  };
}
