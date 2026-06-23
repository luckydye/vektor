import { computed } from "vue";
import { api } from "../api/client.ts";
import { usePagedList } from "./usePagedList.ts";
import { useSpace } from "./useSpace.ts";

export function useAuditLogs(documentId: string, pageSize = 50) {
  const { currentSpaceId } = useSpace();

  const paged = usePagedList({
    queryKey: computed(() => ["document_audit_logs", currentSpaceId.value, documentId]),
    fetcher: ({ limit, offset }) =>
      api.documentAuditLogs
        .get(currentSpaceId.value as string, documentId, { limit, offset })
        .then((r) => ({ items: r.auditLogs, total: r.total })),
    enabled: computed(() => !!currentSpaceId.value),
    pageSize,
  });

  return {
    auditLogs: paged.items,
    isLoading: paged.isLoading,
    isFetching: paged.isFetching,
    error: computed(() => paged.error.value?.message ?? null),
    fetchAuditLogs: paged.refresh,
    // Pagination controls
    page: paged.page,
    totalPages: paged.totalPages,
    total: paged.total,
    goToPage: paged.goToPage,
  };
}
