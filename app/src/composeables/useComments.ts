import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { computed, type Ref, ref } from "vue";
import type { Comment } from "../api/ApiClient.ts";
import { api } from "../api/client.ts";
import {
  isPositionReference,
  resolveReferenceSelector,
} from "../utils/commentReference.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import { useSync } from "./useSync.ts";

export function useComments(options: {
  spaceId: Ref<string | undefined>;
  documentId: Ref<string | undefined>;
  currentRev?: Ref<number | undefined>;
}) {
  const queryClient = useQueryClient();
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
      return await api.documentComments.get(
        options.spaceId.value,
        options.documentId.value,
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

      return await api.documentComments.post(
        options.spaceId.value,
        options.documentId.value,
        {
          content,
          parentId: null,
          reference: payloadReference,
          type: "comment",
        },
      );
    },
    onSuccess: (newComment) => {
      queryClient.setQueryData(
        ["wiki_comments", options.spaceId.value, options.documentId.value],
        (old: Comment[] | undefined) => {
          return old ? [...old, newComment] : [newComment];
        },
      );
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
      return await api.documentComments.delete(
        options.spaceId.value,
        options.documentId.value,
        commentId,
      );
    },
    onSuccess: (_, commentId) => {
      queryClient.setQueryData(
        ["wiki_comments", options.spaceId.value, options.documentId.value],
        (old: Comment[] | undefined) => {
          return old ? old.filter((c: Comment) => c.id !== commentId) : [];
        },
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
      await api.documentComments.patch(options.spaceId.value, options.documentId.value, {
        commentIds,
        reference: newReference,
      });
      return { reference, commentIds, newReference };
    },
    onSuccess: (result) => {
      if (!result) return;
      queryClient.setQueryData(
        ["wiki_comments", options.spaceId.value, options.documentId.value],
        (old: Comment[] | undefined) =>
          old?.map((c: Comment) =>
            result.commentIds.includes(c.id)
              ? { ...c, reference: result.newReference }
              : c,
          ),
      );
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
    submitComment,
    deleteComment,
    moveThread,
    handleOpenComment,
    setupListeners,
    cleanupListeners,
  };
}
