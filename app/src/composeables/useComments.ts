import { type Accessor, createMemo, createSignal } from "solid-js";
import type { Comment } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useMutation, useQuery } from "./query.ts";
import { useSync } from "./useSync.ts";

/**
 * Comment references come in three shapes:
 * - a JSON envelope `{"selector": "...", "rev": 3}` wrapping a selector
 * - a CSS selector / element id anchoring the comment to an element
 * - a plain number: a y offset in px relative to the top of the
 *   `document-view` content (scroll-independent)
 */

/** Unwrap the `{selector, rev}` JSON envelope if present. */
export function resolveReferenceSelector(reference: string): string {
  if (reference.startsWith("{")) {
    try {
      const parsed = JSON.parse(reference);
      if (typeof parsed?.selector === "string") return parsed.selector;
    } catch {}
  }
  return reference;
}

/** True if the reference is a y-position (numeric) reference. */
export function isPositionReference(reference: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(reference);
}

/** True if the reference targets an inline comment-anchor mark in the editor. */
export function isInlineAnchorReference(reference: string): boolean {
  return reference.startsWith("[data-comment-id=");
}

export function useComments(options: {
  spaceId: Accessor<string | undefined>;
  documentId: Accessor<string | undefined>;
  currentRev?: Accessor<number | undefined>;
}) {
  const [activeReference, setActiveReference] = createSignal<string | null>(null);
  const [threadPosition, setThreadPosition] = createSignal(0);

  const {
    data: commentsData,
    isPending: isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: createMemo(() => [
      "wiki_comments",
      options.spaceId(),
      options.documentId(),
    ]),
    queryFn: async () => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) {
        throw new Error("Space ID and Document ID are required");
      }
      return await api.comments.get(spaceId, documentId);
    },
    initialData: async () => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) return undefined;
      return await api.comments.getCached(spaceId, documentId);
    },
    subscribe: (callback) => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) return () => {};
      return api.comments.subscribeCached(spaceId, documentId, callback);
    },
    enabled: createMemo(() => !!options.spaceId() && !!options.documentId()),
  });

  const comments = createMemo(() => commentsData() || []);

  useSync(
    createMemo(() => options.spaceId() ?? null),
    () => {
      const documentId = options.documentId();
      return documentId ? [realtimeTopics.document(documentId)] : [];
    },
    (_, event) => {
      const hasCommentEvent = event.events.some(
        ({ data }) =>
          typeof data?.kind === "string" &&
          (data.kind === "comment_created" ||
            data.kind === "comment_deleted" ||
            data.kind === "comment_updated"),
      );

      if (hasCommentEvent) {
        void refetch();
      }
    },
  );

  const submitCommentMutation = useMutation({
    mutationFn: async ({
      content,
      reference,
    }: {
      content: string;
      reference: string | null;
    }) => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) {
        throw new Error("Space ID and Document ID are required");
      }
      const payloadReference =
        reference && options.currentRev?.() !== undefined
          ? JSON.stringify({
              selector: reference,
              rev: options.currentRev(),
            })
          : reference;

      return await api.comments.post(spaceId, documentId, {
        content,
        parentId: null,
        reference: payloadReference,
        type: "comment",
      });
    },
    onError: (error) => {
      console.error("Error posting comment:", error);
      alert("Could not post comment. Please try again.");
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async (commentId: string) => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) {
        throw new Error("Space ID and Document ID are required");
      }
      return await api.comments.delete(spaceId, documentId, commentId);
    },
    onError: (error) => {
      console.error("Error deleting comment:", error);
      alert("Could not delete comment. Please try again.");
    },
  });

  const activeComments = createMemo(() => {
    if (!activeReference()) return [];
    return comments().filter(
      (c: Comment) =>
        c.reference && resolveReferenceSelector(c.reference) === activeReference(),
    );
  });

  const resolveThreadMutation = useMutation({
    mutationFn: async ({ reference }: { reference: string }) => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) {
        throw new Error("Space ID and Document ID are required");
      }
      const commentIds = comments()
        .filter(
          (c: Comment) =>
            c.reference && resolveReferenceSelector(c.reference) === reference,
        )
        .map((c: Comment) => c.id);
      if (commentIds.length === 0) return null;

      await api.comments.resolve(spaceId, documentId, commentIds);
      return { reference, commentIds };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (activeReference() === result.reference) {
        setActiveReference(null);
      }
    },
    onError: (error) => {
      console.error("Error resolving comment thread:", error);
    },
  });

  const moveThreadMutation = useMutation({
    mutationFn: async ({ reference, y }: { reference: string; y: number }) => {
      const spaceId = options.spaceId();
      const documentId = options.documentId();
      if (!spaceId || !documentId) {
        throw new Error("Space ID and Document ID are required");
      }
      const commentIds = comments()
        .filter(
          (c: Comment) =>
            c.reference && resolveReferenceSelector(c.reference) === reference,
        )
        .map((c: Comment) => c.id);
      if (commentIds.length === 0) return null;

      const newReference = String(Math.round(y));
      await api.comments.patch(spaceId, documentId, {
        commentIds,
        reference: newReference,
      });
      return { reference, commentIds, newReference };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (activeReference() === result.reference) {
        setActiveReference(result.newReference);
      }
    },
    onError: (error) => {
      console.error("Error moving comment thread:", error);
    },
  });

  function handleOpenComment(event: Event) {
    const customEvent = event as CustomEvent<{ reference?: string }>;
    const ref = customEvent.detail?.reference;

    if (ref) {
      if (activeReference() === ref) {
        setActiveReference(null);
        return;
      }

      setActiveReference(ref);

      const docContent = document.querySelector("document-view");
      const root = docContent?.shadowRoot || document;

      if (isPositionReference(ref)) {
        // Position references are y offsets relative to the document content;
        // convert to viewport coordinates for the fixed-positioned thread.
        const docTop = docContent ? docContent.getBoundingClientRect().top : 0;
        setThreadPosition(docTop + Number(ref));
      } else {
        let element = null;
        if (ref.startsWith("#")) {
          element = root.querySelector(ref) || root.getElementById(ref.slice(1));
        } else {
          try {
            element = root.querySelector(ref);
          } catch {}
        }

        if (element) {
          const rect = element.getBoundingClientRect();
          setThreadPosition(rect.top);
        }
      }
    }
  }

  function setupListeners() {
    window.addEventListener("comment:create", handleOpenComment);
  }

  function cleanupListeners() {
    window.removeEventListener("comment:create", handleOpenComment);
  }

  async function submitComment(content: string, reference: string | null) {
    return await submitCommentMutation.mutateAsync({ content, reference });
  }

  async function deleteComment(commentId: string) {
    return await deleteCommentMutation.mutateAsync(commentId);
  }

  async function moveThread(reference: string, y: number) {
    return await moveThreadMutation.mutateAsync({ reference, y });
  }

  async function resolveThread(reference: string) {
    return await resolveThreadMutation.mutateAsync({ reference });
  }

  return {
    comments,
    activeReference,
    // CommentBubble closes a thread it did not open, so it needs the setter.
    setActiveReference,
    threadPosition,
    isLoading,
    error,
    isSubmitting: submitCommentMutation.isPending,
    isDeletingComment: deleteCommentMutation.isPending,
    activeComments,
    refetch,
    isResolvingThread: resolveThreadMutation.isPending,
    submitComment,
    deleteComment,
    moveThread,
    resolveThread,
    handleOpenComment,
    setupListeners,
    cleanupListeners,
  };
}
