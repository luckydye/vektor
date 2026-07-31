import { type Accessor, createContext, createMemo, useContext } from "solid-js";
import { api, type Space } from "#api/client.ts";

export type { Space };

import { type MaybeAccessor, useMutation, useQuery } from "./query.ts";

export type { MaybeAccessor };

/**
 * The space the shell has routed to.
 *
 * Replaces Vue's `provide("space:activeId", …)` from `SpaceApp.vue`. Context
 * rather than a module-level signal because a server render handles several
 * requests at once, and a module singleton would leak one request's space into
 * another's markup.
 */
export const ActiveSpaceIdContext = createContext<Accessor<string | null>>(() => null);

export function useSpace(activeSpaceIdOverride?: Accessor<string | null>) {
  const contextSpaceId = useContext(ActiveSpaceIdContext);
  const activeSpaceId = activeSpaceIdOverride ?? contextSpaceId;

  const { data: spaces, isPending } = useQuery<Space[]>({
    queryKey: ["wiki_spaces"],
    queryFn: () => api.spaces.get(),
    initialData: () => api.spaces.getCached(),
    subscribe: (callback) => api.spaces.subscribeCached(callback),
  });

  const currentSpace = createMemo<Space | null>(() => {
    const all = spaces();
    if (!all) return null;
    const active = activeSpaceId();
    if (active) return all.find((space) => space.id === active) ?? all[0] ?? null;
    return all[0] ?? null;
  });

  const spaceNotFound = createMemo(
    () => !isPending() && spaces() !== undefined && currentSpace() === null,
  );

  const createSpaceMutation = useMutation({
    mutationFn: async (params: {
      name: string;
      slug: string;
      preferences?: Record<string, string>;
    }) => await api.spaces.post(params),
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

  return {
    isLoading: isPending,
    currentSpace,
    currentSpaceId: createMemo(() => currentSpace()?.id ?? null),
    spaceNotFound,
    spaces,
    createSpace: (name: string, slug: string, preferences?: Record<string, string>) =>
      createSpaceMutation.mutateAsync({ name, slug, preferences }),
    updateSpace: (
      spaceId: string,
      name: string,
      slug: string,
      preferences?: Record<string, string>,
    ) => updateSpaceMutation.mutateAsync({ spaceId, name, slug, preferences }),
    deleteSpace: async (spaceId: string) => {
      await deleteSpaceMutation.mutateAsync(spaceId);
    },
  };
}
