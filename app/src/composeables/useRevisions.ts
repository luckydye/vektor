import { type Ref, ref } from "vue";
import { useSpace } from "./useSpace.ts";
import { api, type RevisionMetadata, type RevisionWithContent } from "../api/client.ts";

export type RevisionStatus = "idle" | "saving" | "saved" | "error";

export function useRevisions(documentId: string | undefined) {
  const { currentSpaceId } = useSpace();
  const revisions: Ref<RevisionMetadata[]> = ref([]);
  const isLoading: Ref<boolean> = ref(false);
  const error: Ref<string | null> = ref(null);
  const saveStatus: Ref<RevisionStatus> = ref("idle");

  async function saveRevision(
    html: string,
    message?: string,
  ): Promise<RevisionMetadata | null> {
    if (!currentSpaceId.value) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      return null;
    }

    saveStatus.value = "saving";
    error.value = null;

    try {
      const revision = await api.document.post(currentSpaceId.value, documentId, {
        html,
        message,
      });

      saveStatus.value = "saved";

      setTimeout(() => {
        if (saveStatus.value === "saved") {
          saveStatus.value = "idle";
        }
      }, 2000);

      await fetchHistory();

      return revision as unknown as RevisionMetadata;
    } catch (err) {
      saveStatus.value = "error";
      error.value = err instanceof Error ? err.message : "Unknown error";
      return null;
    }
  }

  async function publishRevision(rev: number): Promise<boolean> {
    if (!currentSpaceId.value) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      throw new Error("No document selected");
    }

    try {
      await api.document.patch(currentSpaceId.value, documentId, { publishedRev: rev });

      window.dispatchEvent(new CustomEvent("document-published"));

      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Unknown error";
      return false;
    }
  }

  async function fetchHistory(): Promise<void> {
    if (!currentSpaceId.value) {
      return;
    }

    if (!documentId) {
      return;
    }

    isLoading.value = true;
    error.value = null;

    try {
      revisions.value = await api.documentHistory.get(currentSpaceId.value, documentId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Unknown error";
    } finally {
      isLoading.value = false;
    }
  }

  async function getRevision(rev: number): Promise<RevisionWithContent | null> {
    if (!currentSpaceId.value) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      throw new Error("No document selected");
    }

    try {
      const document = await api.document.get(currentSpaceId.value, documentId, { rev });
      return document as unknown as RevisionWithContent;
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Unknown error";
      return null;
    }
  }

  return {
    revisions,
    isLoading,
    error,
    saveStatus,
    saveRevision,
    publishRevision,
    fetchHistory,
    getRevision,
  };
}
