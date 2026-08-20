import { useNavigate } from "@solidjs/router";
import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  useContext,
} from "solid-js";
import { api } from "#api/client.ts";
import { placeholderDocumentTitle, supportsDocumentEditor } from "#documents/types.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { access, type MaybeAccessor, useMutation, useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";
import { useToast } from "./useToast.ts";

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

/**
 * Read a document and the mutations that write it back.
 *
 * The id and type are accessors because the views that render a document are
 * reused across navigation: `DocumentPageView` only tears its subtree down when
 * the next document has to be fetched, so a cached one swaps in under the same
 * component instances. A snapshotted id would freeze the query key on whichever
 * document happened to be showing when the caller was created.
 */
export function useDocument(
  documentIdInput: MaybeAccessor<string | undefined>,
  documentTypeInput: MaybeAccessor<string> = "document",
) {
  const documentId = () => access(documentIdInput);
  const documentType = () => access(documentTypeInput);
  const { currentSpaceId, currentSpace } = useSpace();
  const navigate = useNavigate();
  const toast = useToast();
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
    queryKey: createMemo(() => ["wiki_document", spaceId(), documentId()]),
    queryFn: async () => {
      const id = spaceId();
      const docId = documentId();
      if (!id) throw new Error("No space ID");
      if (!docId) return null;
      return await api.document.get(id, docId);
    },
    initialData: async () => {
      const id = spaceId();
      const docId = documentId();
      if (!id || !docId) return undefined;
      return await api.document.getCached(id, docId);
    },
    subscribe: (callback) => {
      const id = spaceId();
      const docId = documentId();
      if (!id || !docId) return () => {};
      return api.document.subscribeCached(id, docId, callback);
    },
    enabled: createMemo(() => !!spaceId() && !!documentId()),
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
      const docId = documentId();
      if (docId) {
        await api.document.put(spaceId, docId, content, { publish });
        return { content, isNew: false };
      } else {
        const defaultTitle = placeholderDocumentTitle(documentType());
        const params = new URLSearchParams(window.location.search);
        // `?title=` is how the command palette seeds a draft. It is a fallback
        // behind `pendingTitle` — the title editor only reports a change when the
        // user actually edits, so an untouched seeded title never arrives there.
        const title = pendingTitle || params.get("title")?.trim() || defaultTitle;
        const category = params.get("category");
        // `?parent=` is how the command palette files a draft under the document
        // the user was reading when they created it.
        const parentId = params.get("parent");
        const response = await api.documents.post(spaceId, {
          content,
          type: documentType(),
          ...(parentId ? { parentId } : {}),
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
      const message = error instanceof Error ? error.message : "Unknown error";
      setSaveError(message);
      // `saveError` is only read for status; without this the failure is silent.
      toast.error(message);
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
    () => {
      const docId = documentId();
      return docId ? [realtimeTopics.document(docId)] : [];
    },
    (keys) => {
      const docId = documentId();
      if (docId && keys.includes(realtimeTopics.document(docId))) {
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
