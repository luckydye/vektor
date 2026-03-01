import { computed, ref, type Ref } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { api } from "../api/client.ts";
import type { Comment } from "../api/ApiClient.ts";

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
    return comments.value.filter((c: Comment) => {
      let ref = c.reference;
      try {
        if (ref?.startsWith("{")) {
          ref = JSON.parse(ref).selector;
        }
      } catch {}
      return ref === activeReference.value;
    });
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

      if (!Number.isNaN(activeReference.value)) {
        threadPosition.value = Number(activeReference.value);
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
    handleOpenComment,
    setupListeners,
    cleanupListeners,
  };
}
