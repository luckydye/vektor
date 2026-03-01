import { type Ref, ref, watchEffect } from "vue";
import { useSpace } from "./useSpace.ts";
import { api, type DocumentContributor } from "../api/client.ts";

export function useContributors(documentId?: string) {
  const { currentSpaceId } = useSpace();
  const contributors: Ref<DocumentContributor[]> = ref([]);
  const isLoading: Ref<boolean> = ref(false);
  const error: Ref<string | null> = ref(null);

  watchEffect(() => {
    if (currentSpaceId.value && documentId) {
      fetchContributors();
    }
  });

  async function fetchContributors(): Promise<void> {
    if (!currentSpaceId.value || !documentId) {
      return;
    }

    isLoading.value = true;
    error.value = null;

    try {
      contributors.value = await api.documentContributors.get(
        currentSpaceId.value,
        documentId,
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Unknown error";
    } finally {
      isLoading.value = false;
    }
  }

  return {
    contributors,
    isLoading,
    error,
    fetchContributors,
  };
}
