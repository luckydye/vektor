import { type Accessor, createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/**
 * The document id is an accessor: the document view is reused across
 * same-type navigation, so a snapshotted id would keep serving the
 * contributors of whichever document was open first.
 */
export function useContributors(documentId: Accessor<string | undefined>) {
  const { currentSpaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["document_contributors", currentSpaceId(), documentId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      const id = documentId();
      if (!spaceId || !id) throw new Error("Space ID and Document ID are required");
      return await api.documentContributors.get(spaceId, id);
    },
    enabled: createMemo(() => !!currentSpaceId() && !!documentId()),
  });

  const contributors = createMemo(() => data() ?? []);

  return { contributors, isLoading, error, refresh };
}
