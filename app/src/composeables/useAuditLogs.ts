import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { useCursorPagedList } from "./useCursorPagedList.ts";
import { useSpace } from "./useSpace.ts";

export function useAuditLogs(documentId: string, pageSize = 50) {
  const { currentSpaceId } = useSpace();

  const paged = useCursorPagedList({
    queryKey: createMemo(() => ["document_audit_logs", currentSpaceId(), documentId]),
    fetcher: ({ limit, cursor }) =>
      api.auditLogs
        .get(currentSpaceId() as string, { documentId, limit, cursor })
        .then((r) => ({ items: r.auditLogs, nextCursor: r.nextCursor })),
    enabled: createMemo(() => !!currentSpaceId()),
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
