import { computed, type Ref, ref } from "vue";
import { api } from "../api/client.ts";
import { supportsDocumentEditor } from "../utils/documentTypes.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export type DocumentContext = {
  documentId?: string;
  documentType: string;
  readonly: boolean;
  publishedVersion: number | null;
  userCanEdit: boolean;
};

export type DocumentContextInput = Partial<DocumentContext>;

const documentContext = ref<DocumentContext>({
  documentId: undefined,
  documentType: "document",
  readonly: false,
  publishedVersion: null,
  userCanEdit: false,
});

function normalizeDocumentContext(input: DocumentContextInput): DocumentContext {
  return {
    documentId: input.documentId,
    documentType: input.documentType || "document",
    readonly: input.readonly ?? false,
    publishedVersion: input.publishedVersion ?? null,
    userCanEdit: input.userCanEdit ?? false,
  };
}

function sameDocumentContext(a: DocumentContext, b: DocumentContext): boolean {
  return (
    a.documentId === b.documentId &&
    a.documentType === b.documentType &&
    a.readonly === b.readonly &&
    a.publishedVersion === b.publishedVersion &&
    a.userCanEdit === b.userCanEdit
  );
}

export function useDocumentContext() {
  const canUseDocumentEditor = computed(
    () =>
      supportsDocumentEditor(documentContext.value.documentType) &&
      !documentContext.value.readonly &&
      documentContext.value.userCanEdit,
  );
  const hasPublishedVersion = computed(
    () => documentContext.value.publishedVersion != null,
  );

  function setDocumentContext(input: DocumentContextInput): boolean {
    const nextContext = normalizeDocumentContext({
      ...documentContext.value,
      ...input,
    });
    if (sameDocumentContext(documentContext.value, nextContext)) return false;

    documentContext.value = nextContext;
    return true;
  }

  function markDocumentPublished(version = 0): void {
    if (documentContext.value.publishedVersion != null) return;
    documentContext.value = {
      ...documentContext.value,
      publishedVersion: version,
    };
  }

  function resetDocumentContext(): void {
    documentContext.value = {
      documentId: undefined,
      documentType: "document",
      readonly: false,
      publishedVersion: null,
      userCanEdit: false,
    };
  }

  return {
    documentContext,
    canUseDocumentEditor,
    hasPublishedVersion,
    setDocumentContext,
    markDocumentPublished,
    resetDocumentContext,
  };
}

export function useDocument(documentId: string | undefined, documentType = "document") {
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
    mutationFn: async ({ content, publish }: { content: string; publish?: boolean }) => {
      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }
      if (documentId) {
        await api.document.put(currentSpaceId.value, documentId, content, { publish });
        return { content, isNew: false };
      } else {
        const defaultTitle =
          documentType === "canvas" ? "Untitled Canvas" : "Untitled Document";
        const title = pendingTitle || defaultTitle;
        const category = new URLSearchParams(window.location.search).get("category");
        const response = await api.documents.post(currentSpaceId.value, {
          content,
          type: documentType,
          properties: {
            title,
            ...(category ? { category } : {}),
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

  async function saveDocument(
    content: string,
    options?: { publish?: boolean },
  ): Promise<boolean> {
    try {
      await saveDocumentMutation.mutateAsync({ content, publish: options?.publish });
      return true;
    } catch {
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
  useSync(
    spaceId,
    () => (documentId ? [realtimeTopics.document(documentId)] : []),
    (keys) => {
      if (documentId && keys.includes(realtimeTopics.document(documentId))) {
        refresh();
      }
    },
  );

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
