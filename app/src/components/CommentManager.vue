<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { plusSmallIcon } from "~/src/assets/icons.ts";
import type { Comment as ApiComment } from "../api/ApiClient.ts";
import { useComments } from "../composeables/useComments.ts";
import type { Comment as CommentOverlaysType } from "./CommentOverlays.vue";
import CommentOverlays from "./CommentOverlays.vue";
import type { Comment as CommentThreadType } from "./CommentThread.vue";
import CommentThread from "./CommentThread.vue";

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
  moveThread,
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
const addingCommentRef = ref<string | null>(null);
const fadeAddBubble = ref(false);

const EDGE_THRESHOLD_PX = 60;
const COMMENT_BUBBLE_PROXIMITY_PX = 20;
const THREAD_GAP_PX = 8;

// Thread anchor derived from the comment bubble the thread belongs to,
// so the thread stays attached to the bubble instead of the viewport edge.
const threadAnchor = ref<{ top: number; right: number } | null>(null);

function bubbleForReference(reference: string): HTMLElement | null {
  const bubbles = document.querySelectorAll<HTMLElement>(
    "[data-comment-overlay-bubble='true']",
  );
  return (
    Array.from(bubbles).find((b) => b.dataset.commentReference === reference) ?? null
  );
}

function updateThreadAnchor() {
  if (!activeReference.value) {
    threadAnchor.value = null;
    return;
  }
  const bubble = bubbleForReference(activeReference.value);
  if (!bubble) {
    threadAnchor.value = null;
    return;
  }
  const rect = bubble.getBoundingClientRect();
  threadAnchor.value = {
    top: rect.top,
    right: window.innerWidth - rect.left + THREAD_GAP_PX,
  };
}

function handleThreadReposition() {
  if (!activeReference.value) return;
  requestAnimationFrame(updateThreadAnchor);
}

watch(activeReference, () => {
  // Wait for the bubble overlay to render before measuring it.
  void nextTick(updateThreadAnchor);
});

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

  if (e.clientX > window.innerWidth - EDGE_THRESHOLD_PX && e.clientY > 200) {
    showAddBubble.value = true;
    bubbleY.value = e.clientY;
    fadeAddBubble.value = isNearCommentBubble(e.clientX, e.clientY);
  } else {
    showAddBubble.value = false;
    fadeAddBubble.value = false;
  }
}

function isNearCommentBubble(cursorX: number, cursorY: number) {
  const bubbles = document.querySelectorAll<HTMLElement>(
    "[data-comment-overlay-bubble='true']",
  );

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
  // Viewport y for the fixed-positioned thread popup
  addingCommentY.value = bubbleY.value;
  // Stored reference is the y offset relative to the document content,
  // so the bubble stays anchored regardless of scroll position.
  const docView = document.querySelector("document-view");
  const docTop = docView ? docView.getBoundingClientRect().top : 0;
  addingCommentRef.value = String(Math.max(0, Math.round(bubbleY.value - docTop)));
  showAddBubble.value = false;
  fadeAddBubble.value = false;
}

async function handleSubmit(payload: { content: string; reference: string | null }) {
  await submitComment(payload.content, payload.reference);
}

async function handleSubmitNew(payload: { content: string; reference: string | null }) {
  await submitComment(payload.content, payload.reference);
  addingCommentY.value = null;
  addingCommentRef.value = null;
}

async function handleMoveThread(payload: { reference: string; y: number }) {
  await moveThread(payload.reference, payload.y);
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
  // Capture phase so scrolls inside nested containers also re-anchor the thread.
  window.addEventListener("scroll", handleThreadReposition, true);
  window.addEventListener("resize", handleThreadReposition);
  window.addEventListener("editor-update", handleThreadReposition);
});

onUnmounted(() => {
  cleanupListeners();
  window.removeEventListener("mousemove", handleMouseMove);
  document.documentElement.removeEventListener("mouseleave", handleMouseLeave);
  window.removeEventListener("scroll", handleThreadReposition, true);
  window.removeEventListener("resize", handleThreadReposition);
  window.removeEventListener("editor-update", handleThreadReposition);
});
</script>

<template>
  <div class="contents">
    <CommentOverlays :comments="commentsForOverlays" @move="handleMoveThread" />

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
        <div class="svg-icon w-4 h-4" v-html="plusSmallIcon" />
      </button>
    </div>

    <!-- Thread for existing comment reference — anchored to its comment bubble -->
    <div
      v-if="activeReference"
      class="fixed z-40"
      :style="threadAnchor
        ? { top: `${threadAnchor.top}px`, right: `${threadAnchor.right}px` }
        : { top: `${threadPosition}px`, right: '1rem' }"
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
        :activeReference="addingCommentRef"
        :isSubmitting="isSubmitting"
        :isDeletingComment="isDeletingComment"
        @submit="handleSubmitNew"
        @delete="handleDeleteComment"
        @close="addingCommentY = null; addingCommentRef = null"
      />
    </div>
  </div>
</template>
