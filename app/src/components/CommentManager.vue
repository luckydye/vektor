<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref } from "vue";
import CommentThread, { type Comment as CommentThreadType } from "./CommentThread.vue";
import CommentOverlays, {
  type Comment as CommentOverlaysType,
} from "./CommentOverlays.vue";
import { useComments } from "../composeables/useComments.ts";
import type { Comment as ApiComment } from "../api/ApiClient.ts";

const props = defineProps<{
  spaceId: string;
  documentId: string;
  currentRev?: number;
}>();

const {
  comments,
  activeReference,
  threadPosition,
  isSubmitting,
  isDeletingComment,
  activeComments,
  submitComment,
  deleteComment,
  setupListeners,
  cleanupListeners,
} = useComments({
  spaceId: computed(() => props.spaceId),
  documentId: computed(() => props.documentId),
  currentRev: computed(() => props.currentRev),
});

const showAddBubble = ref(false);
const bubbleY = ref(0);
const addingCommentY = ref<number | null>(null);
const fadeAddBubble = ref(false);

const EDGE_THRESHOLD_PX = 60;
const COMMENT_BUBBLE_PROXIMITY_PX = 20;

const commentsForOverlays = computed(() =>
  comments.value.map(
    (c: ApiComment) =>
      ({
        id: c.id,
        reference: c.reference ?? undefined,
      }) as CommentOverlaysType,
  ),
);

const commentsForThread = computed(() =>
  activeComments.value.map(
    (c: ApiComment) =>
      ({
        id: c.id,
        content: c.content,
        createdAt:
          typeof c.createdAt === "string" ? c.createdAt : c.createdAt.toISOString(),
        createdBy: c.createdBy,
        reference: c.reference ?? undefined,
        parentId: c.parentId ?? undefined,
      }) as CommentThreadType,
  ),
);

function handleMouseMove(e: MouseEvent) {
  if (activeReference.value || addingCommentY.value !== null) {
    showAddBubble.value = false;
    fadeAddBubble.value = false;
    return;
  }

  if (e.clientX > window.innerWidth - EDGE_THRESHOLD_PX) {
    showAddBubble.value = true;
    bubbleY.value = e.clientY;
    fadeAddBubble.value = isNearCommentBubble(e.clientX, e.clientY);
  } else {
    showAddBubble.value = false;
    fadeAddBubble.value = false;
  }
}

function isNearCommentBubble(cursorX: number, cursorY: number) {
  const bubbles = document.querySelectorAll<HTMLElement>("[data-comment-overlay-bubble='true']");

  return Array.from(bubbles).some((bubble) => {
    const rect = bubble.getBoundingClientRect();
    return (
      cursorX >= rect.left - COMMENT_BUBBLE_PROXIMITY_PX &&
      cursorX <= rect.right + COMMENT_BUBBLE_PROXIMITY_PX &&
      cursorY >= rect.top - COMMENT_BUBBLE_PROXIMITY_PX &&
      cursorY <= rect.bottom + COMMENT_BUBBLE_PROXIMITY_PX
    );
  });
}

function handleAddComment() {
  addingCommentY.value = bubbleY.value;
  showAddBubble.value = false;
  fadeAddBubble.value = false;
}

async function handleSubmit(payload: { content: string; reference: string | null }) {
  await submitComment(payload.content, payload.reference);
}

async function handleSubmitNew(payload: { content: string; reference: string | null }) {
  await submitComment(payload.content, payload.reference);
  addingCommentY.value = null;
}

async function handleDeleteComment(commentId: string) {
  await deleteComment(commentId);
}

function handleMouseLeave() {
  showAddBubble.value = false;
  fadeAddBubble.value = false;
}

onMounted(() => {
  setupListeners();
  window.addEventListener("mousemove", handleMouseMove);
  document.documentElement.addEventListener("mouseleave", handleMouseLeave);
});

onUnmounted(() => {
  cleanupListeners();
  window.removeEventListener("mousemove", handleMouseMove);
  document.documentElement.removeEventListener("mouseleave", handleMouseLeave);
});
</script>

<template>
  <div class="contents">
    <CommentOverlays :comments="commentsForOverlays" />

    <!-- Add comment bubble — appears near right viewport edge -->
    <div
      v-if="showAddBubble"
      class="fixed right-4 z-50 -translate-y-1/2 transition-opacity duration-200"
      :class="fadeAddBubble ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'"
      :style="{ top: `${bubbleY}px` }"
    >
      <button
        @click="handleAddComment"
        class="w-8 h-8 rounded-full bg-white border border-neutral-200 shadow-md flex items-center justify-center text-neutral-500 hover:text-primary-600 hover:border-primary-300 hover:shadow-lg transition-all"
        title="Add comment"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>

    <!-- Thread for existing comment reference -->
    <div
      v-if="activeReference"
      class="fixed right-4 z-40"
      :style="{ top: `${threadPosition}px` }"
    >
      <CommentThread
        :comments="commentsForThread"
        :activeReference="activeReference"
        :isSubmitting="isSubmitting"
        :isDeletingComment="isDeletingComment"
        @submit="handleSubmit"
        @delete="handleDeleteComment"
        @close="activeReference = null"
      />
    </div>

    <!-- Thread for new comment (bubble click) -->
    <div
      v-if="addingCommentY !== null && !activeReference"
      class="fixed right-4 z-40"
      :style="{ top: `${addingCommentY}px` }"
    >
      <CommentThread
        :comments="[]"
        :activeReference="String(addingCommentY)"
        :isSubmitting="isSubmitting"
        :isDeletingComment="isDeletingComment"
        @submit="handleSubmitNew"
        @delete="handleDeleteComment"
        @close="addingCommentY = null"
      />
    </div>
  </div>
</template>
