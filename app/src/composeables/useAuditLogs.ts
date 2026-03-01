import { type Ref, ref, watchEffect } from "vue";
import { useSpace } from "./useSpace.ts";
import { api, type AuditLog } from "../api/client.ts";

export function useAuditLogs(documentId: string) {
  const { currentSpaceId } = useSpace();
  const auditLogs: Ref<AuditLog[]> = ref([]);
  const isLoading: Ref<boolean> = ref(false);
  const error: Ref<string | null> = ref(null);

  watchEffect(() => {
    if (currentSpaceId.value) {
      fetchAuditLogs();
    }
  });

  async function fetchAuditLogs(): Promise<void> {
    if (!currentSpaceId.value) {
      return;
    }

    isLoading.value = true;
    error.value = null;

    try {
      auditLogs.value = await api.documentAuditLogs.get(currentSpaceId.value, documentId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Unknown error";
    } finally {
      isLoading.value = false;
    }
  }

  return {
    auditLogs,
    isLoading,
    error,
    fetchAuditLogs,
  };
}
