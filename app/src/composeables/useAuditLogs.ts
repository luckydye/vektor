import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { access, type MaybeAccessor } from "./query.ts";
import { useCursorPagedList } from "./useCursorPagedList.ts";
import { useSpace } from "./useSpace.ts";

/**
 * The id is an accessor for the same reason `useRevisions`' is: a caller that
 * survives navigation would otherwise keep reading the document it was created
 * under.
 */
export function useAuditLogs(
  documentIdInput: MaybeAccessor<string | undefined>,
  pageSize = 50,
) {
  const documentId = () => access(documentIdInput);
  const { currentSpaceId } = useSpace();

  const paged = useCursorPagedList({
    queryKey: createMemo(() => ["document_audit_logs", currentSpaceId(), documentId()]),
    fetcher: ({ limit, cursor }) =>
      api.auditLogs
        .get(currentSpaceId() as string, {
          documentId: documentId() as string,
          limit,
          cursor,
        })
        .then((r) => ({ items: r.auditLogs, nextCursor: r.nextCursor })),
    enabled: createMemo(() => !!currentSpaceId() && !!documentId()),
    pageSize,
  });

  return {
    auditLogs: paged.items,
    isLoading: paged.isLoading,
    isFetching: paged.isFetching,
    error: createMemo(() => paged.error()?.message ?? null),
    fetchAuditLogs: paged.refresh,
    // Pagination controls
    hasPrevPage: paged.hasPrevPage,
    hasNextPage: paged.hasNextPage,
    nextPage: paged.nextPage,
    prevPage: paged.prevPage,
  };
}
