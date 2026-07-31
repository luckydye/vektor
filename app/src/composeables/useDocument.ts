import { useNavigate } from "@solidjs/router";
import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  useContext,
} from "solid-js";
import { api } from "#api/client.ts";
import { supportsDocumentEditor } from "#documents/types.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useMutation, useQuery } from "./query.ts";
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

const DEFAULT_DOCUMENT_CONTEXT: DocumentContext = {
  documentId: undefined,
  documentType: "document",
  readonly: false,
  publishedVersion: null,
  userCanEdit: false,
};

/**
 * The document the surrounding view is showing.
 *
 * A context, like the active space id: SSR-safe because nothing is shared at
 * module level, and it removes the need for a renderless provider component.
 */
export const DocumentContextContext = createContext<
  [Accessor<DocumentContext>, (next: DocumentContext) => void] | null
>(null);

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

/**
 * Create the signal pair a `DocumentContextContext.Provider` carries.
 *
 * Owned by whoever renders the provider, so nothing lives at module level and
 * SSR renders stay isolated from each other. A component that both writes the
 * context and renders readers has to split: the writer's own
 * `useDocumentContext()` runs outside the provider it creates and would get a
 * private signal instead.
 */
export function provideDocumentContext(
  initial?: DocumentContextInput,
): [Accessor<DocumentContext>, (next: DocumentContext) => void] {
  const [documentContext, setDocumentContext] = createSignal<DocumentContext>(
    initial ? normalizeDocumentContext(initial) : { ...DEFAULT_DOCUMENT_CONTEXT },
  );
  // Callers place the returned pair on `DocumentContextContext.Provider`.
  return [documentContext, setDocumentContext];
}

export function useDocumentContext() {
  const provided = useContext(DocumentContextContext);
  const [documentContext, writeDocumentContext] =
    provided ?? createSignal<DocumentContext>({ ...DEFAULT_DOCUMENT_CONTEXT });

  const canUseDocumentEditor = createMemo(
    () =>
      supportsDocumentEditor(documentContext().documentType) &&
      !documentContext().readonly &&
      documentContext().userCanEdit,
  );
  const hasPublishedVersion = createMemo(
    () => documentContext().publishedVersion != null,
  );

  function setDocumentContext(input: DocumentContextInput): boolean {
    const nextContext = normalizeDocumentContext({
      ...documentContext(),
      ...input,
    });
    if (sameDocumentContext(documentContext(), nextContext)) return false;

    writeDocumentContext(nextContext);
    return true;
  }

  function resetDocumentContext(): void {
    writeDocumentContext({ ...DEFAULT_DOCUMENT_CONTEXT });
  }

  return {
    documentContext,
    canUseDocumentEditor,
    hasPublishedVersion,
    setDocumentContext,
    resetDocumentContext,
  };
}

export function useDocument(documentId: string | undefined, documentType = "document") {
  const { currentSpaceId, currentSpace } = useSpace();
  const navigate = useNavigate();
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>("idle");
  const [saveError, setSaveError] = createSignal<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTitle: string | null = null;

  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_document", spaceId(), documentId]),
    queryFn: async () => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      if (!documentId) return null;
      return await api.document.get(id, documentId);
    },
    initialData: async () => {
      const id = spaceId();
      if (!id || !documentId) return undefined;
      return await api.document.getCached(id, documentId);
    },
    subscribe: (callback) => {
      const id = spaceId();
      if (!id || !documentId) return () => {};
      return api.document.subscribeCached(id, documentId, callback);
    },
    enabled: createMemo(() => !!spaceId() && !!documentId),
  });

  const document = createMemo(() => data());

  if (!import.meta.env.SSR) {
    // Listen for title changes when creating a new document
    window.addEventListener("pending-title-changed", (event: Event) => {
      const customEvent = event as CustomEvent;
      pendingTitle = customEvent.detail.title;
    });
  }

  const saveDocumentMutation = useMutation({
    mutationFn: async ({ content, publish }: { content: string; publish?: boolean }) => {
      const spaceId = currentSpaceId();
      if (!spaceId) {
        throw new Error("No space selected");
      }
      if (documentId) {
        await api.document.put(spaceId, documentId, content, { publish });
        return { content, isNew: false };
      } else {
        const defaultTitle =
          documentType === "canvas" ? "Untitled Canvas" : "Untitled Document";
        const title = pendingTitle || defaultTitle;
        const category = new URLSearchParams(window.location.search).get("category");
        const response = await api.documents.post(spaceId, {
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
      setSaveStatus("saving");
      setSaveError(null);
    },
    onSuccess: (data) => {
      setSaveStatus("saved");

      if (data.isNew && data.document && currentSpace()) {
        navigate(`/doc/${data.document.slug}`);
        return;
      }

      setTimeout(() => {
        if (saveStatus() === "saved") {
          setSaveStatus("idle");
        }
      }, 2000);
    },
    onError: (error) => {
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error.message : "Unknown error");
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
