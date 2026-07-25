import { computed, type Ref, ref } from "vue";
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
  spaceId: Ref<string | undefined>;
  documentId: Ref<string | undefined>;
  currentRev?: Ref<number | undefined>;
}) {
  const activeReference = ref<string | null>(null);
  const threadPosition = ref(0);

  const {
    data: commentsData,
    isPending: isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: computed(() => [
      "wiki_comments",
      options.spaceId.value,
      options.documentId.value,
    ]),
    queryFn: async () => {
      if (!options.spaceId.value || !options.documentId.value) {
        throw new Error("Space ID and Document ID are required");
      }
      return await api.comments.get(options.spaceId.value, options.documentId.value);
    },
    initialData: async () => {
      if (!options.spaceId.value || !options.documentId.value) return undefined;
      return await api.comments.getCached(
        options.spaceId.value,
        options.documentId.value,
      );
    },
    subscribe: (callback) => {
      if (!options.spaceId.value || !options.documentId.value) return () => {};
      return api.comments.subscribeCached(
        options.spaceId.value,
        options.documentId.value,
        callback,
      );
    },
    enabled: computed(() => !!options.spaceId.value && !!options.documentId.value),
  });

  const comments = computed(() => commentsData.value || []);

  useSync(
    computed(() => options.spaceId.value ?? null),
    () =>
      options.documentId.value ? [realtimeTopics.document(options.documentId.value)] : [],
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
      if (!options.spaceId.value || !options.documentId.value) {
        throw new Error("Space ID and Document ID are required");
      }
      const payloadReference =
        reference && options.currentRev?.value !== undefined
          ? JSON.stringify({
              selector: reference,
              rev: options.currentRev.value,
            })
          : reference;

      return await api.comments.post(options.spaceId.value, options.documentId.value, {
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
      if (!options.spaceId.value || !options.documentId.value) {
        throw new Error("Space ID and Document ID are required");
      }
      return await api.comments.delete(
        options.spaceId.value,
        options.documentId.value,
        commentId,
      );
    },
    onError: (error) => {
      console.error("Error deleting comment:", error);
      alert("Could not delete comment. Please try again.");
    },
  });

  const activeComments = computed(() => {
    if (!activeReference.value) return [];
    return comments.value.filter(
      (c: Comment) =>
        c.reference && resolveReferenceSelector(c.reference) === activeReference.value,
    );
  });

  const resolveThreadMutation = useMutation({
    mutationFn: async ({ reference }: { reference: string }) => {
      if (!options.spaceId.value || !options.documentId.value) {
        throw new Error("Space ID and Document ID are required");
      }
      const commentIds = comments.value
        .filter(
          (c: Comment) =>
            c.reference && resolveReferenceSelector(c.reference) === reference,
        )
        .map((c: Comment) => c.id);
      if (commentIds.length === 0) return null;

      await api.comments.resolve(
        options.spaceId.value,
        options.documentId.value,
        commentIds,
      );
      return { reference, commentIds };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (activeReference.value === result.reference) {
        activeReference.value = null;
      }
    },
    onError: (error) => {
      console.error("Error resolving comment thread:", error);
    },
  });

  const moveThreadMutation = useMutation({
    mutationFn: async ({ reference, y }: { reference: string; y: number }) => {
      if (!options.spaceId.value || !options.documentId.value) {
        throw new Error("Space ID and Document ID are required");
      }
      const commentIds = comments.value
        .filter(
          (c: Comment) =>
            c.reference && resolveReferenceSelector(c.reference) === reference,
        )
        .map((c: Comment) => c.id);
      if (commentIds.length === 0) return null;

      const newReference = String(Math.round(y));
      await api.comments.patch(options.spaceId.value, options.documentId.value, {
        commentIds,
        reference: newReference,
      });
      return { reference, commentIds, newReference };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (activeReference.value === result.reference) {
        activeReference.value = result.newReference;
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
      if (activeReference.value === ref) {
        activeReference.value = null;
        return;
      }

      activeReference.value = ref;

      const docContent = document.querySelector("document-view");
      const root = docContent?.shadowRoot || document;

      if (isPositionReference(ref)) {
        // Position references are y offsets relative to the document content;
        // convert to viewport coordinates for the fixed-positioned thread.
        const docTop = docContent ? docContent.getBoundingClientRect().top : 0;
        threadPosition.value = docTop + Number(ref);
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
          threadPosition.value = rect.top;
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
