import { type Ref, ref, computed } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { useSpace } from "./useSpace.ts";
import { api } from "../api/client.ts";
import { useSync } from "./useSync.ts";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export function useDocument(
  documentId: string | undefined,
  documentType: "document" | "canvas" = "document",
) {
  const { currentSpaceId, currentSpace } = useSpace();
  const queryClient = useQueryClient();
  const saveStatus: Ref<SaveStatus> = ref("idle");
  const saveError: Ref<string | null> = ref(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTitle: string | null = null;

  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: computed(() => ["wiki_document", spaceId.value, documentId]),
    queryFn: async () => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      if (!documentId) {
        return null;
      }
      return await api.document.get(spaceId.value, documentId);
    },
    enabled: computed(() => !!spaceId.value && !!documentId),
  });

  const document = computed(() => data.value);

  if (!import.meta.env.SSR) {
    // Listen for title changes when creating a new document
    window.addEventListener("pending-title-changed", (event: Event) => {
      const customEvent = event as CustomEvent;
      pendingTitle = customEvent.detail.title;
    });
  }

  const saveDocumentMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }
      if (documentId) {
        await api.document.put(currentSpaceId.value, documentId, content);
        return { content, isNew: false };
      } else {
        const defaultTitle =
          documentType === "canvas" ? "Untitled Canvas" : "Untitled Document";
        const title = pendingTitle || defaultTitle;
        const response = await api.documents.post(currentSpaceId.value, {
          content,
          type: documentType,
          properties: {
            title,
            ...(new URLSearchParams(window.location.search).get("category")
              ? { category: new URLSearchParams(window.location.search).get("category")! }
              : {}),
          },
        });
        return { content, isNew: true, document: response };
      }
    },
    onMutate: () => {
      saveStatus.value = "saving";
      saveError.value = null;
    },
    onSuccess: (data) => {
      saveStatus.value = "saved";

      if (data.isNew && data.document && currentSpace.value) {
        window.location.href = `/${currentSpace.value.slug}/doc/${data.document.slug}`;
        return;
      }

      queryClient.invalidateQueries({
        queryKey: ["wiki_document", currentSpaceId.value, documentId],
      });

      setTimeout(() => {
        if (saveStatus.value === "saved") {
          saveStatus.value = "idle";
        }
      }, 2000);
    },
    onError: (error) => {
      saveStatus.value = "error";
      saveError.value = error instanceof Error ? error.message : "Unknown error";
    },
  });

  async function saveDocument(content: string): Promise<boolean> {
    try {
      await saveDocumentMutation.mutateAsync(content);
      return true;
    } catch (error) {
      return false;
    }
  }

  function debouncedSave(content: string, delay = 2000): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      saveDocument(content);
    }, delay);
  }

  function cancelDebounce(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // TODO: syncs are not scopped to documents,
  // one prop updates will send a sync event to all users anywhere in the space
  useSync(spaceId, (keys) => {
    if (keys.includes("property")) refresh();
  });

  return {
    document,
    isLoading,
    refresh,
    error,
    saveStatus,
    saveError,
    saveDocument,
    debouncedSave,
    cancelDebounce,
  };
}
