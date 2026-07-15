<script setup lang="ts">
import type { Editor } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { Comment as ApiComment } from "#api/ApiClient.ts";
import { useComments } from "#composeables/useComments.ts";
import {
  isInlineAnchorReference,
  resolveReferenceSelector,
} from "#utils/commentReference.ts";
import { plusSmallIcon } from "~/src/assets/icons.ts";
import type { Comment as CommentThreadType } from "./CommentThread.vue";
import CommentThread from "./CommentThread.vue";

const props = defineProps<{
  spaceId: string;
  documentId: string;
  currentRev?: number;
  editor?: Editor;
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
  resolveThread,
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

// Inline anchor click tooltip
const clickedAnchorRef = ref<string | null>(null);
const tooltipPos = ref({ top: 0, left: 0 });
const tooltipEl = ref<HTMLElement | null>(null);

function anchorFromPath(e: MouseEvent): { el: HTMLElement; commentId: string } | null {
  for (const node of e.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.commentId) {
      return { el: node, commentId: node.dataset.commentId };
    }
  }
  return null;
}

function handleDocumentClick(e: MouseEvent) {
  const hit = anchorFromPath(e);
  if (!hit) {
    // Click outside tooltip closes it
    if (tooltipEl.value && !tooltipEl.value.contains(e.target as Node)) {
      clickedAnchorRef.value = null;
    }
    return;
  }
  const ref = `[data-comment-id="${hit.commentId}"]`;
  // Toggle off if clicking the same anchor again
  if (clickedAnchorRef.value === ref) {
    clickedAnchorRef.value = null;
    return;
  }
  clickedAnchorRef.value = ref;
  const rect = hit.el.getBoundingClientRect();
  const tooltipWidth = 320;
  tooltipPos.value = {
    top: rect.bottom + 6,
    left: Math.min(rect.left, window.innerWidth - tooltipWidth - 8),
  };
}

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
  comments.value.map((c: ApiComment) => ({
    id: c.id,
    reference: c.reference ?? undefined,
  })),
);

const clickedAnchorComments = computed(() => {
  if (!clickedAnchorRef.value) return [];
  return comments.value
    .filter(
      (c: ApiComment) =>
        c.reference && resolveReferenceSelector(c.reference) === clickedAnchorRef.value,
    )
    .map(
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
    );
});

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

function removeCommentAnchorMark(reference: string) {
  const editor = props.editor;
  if (!editor || editor.isDestroyed) return;
  const match = reference.match(/\[data-comment-id="([^"]+)"\]/);
  if (!match) return;
  const commentId = match[1];
  const { state, view } = editor;
  const tr = state.tr;
  let modified = false;
  state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;
    const mark = node.marks.find(
      (m: Mark) => m.type.name === "commentAnchor" && m.attrs.commentId === commentId,
    );
    if (mark) {
      tr.removeMark(pos, pos + node.nodeSize, mark.type);
      modified = true;
    }
  });
  if (modified) view.dispatch(tr);
}

async function handleResolve(reference: string | null) {
  if (!reference) return;
  await resolveThread(reference);
  if (isInlineAnchorReference(reference)) {
    removeCommentAnchorMark(reference);
  }
  clickedAnchorRef.value = null;
}

function handleCloseThread() {
  if (
    activeReference.value &&
    isInlineAnchorReference(activeReference.value) &&
    commentsForThread.value.length === 0
  ) {
    removeCommentAnchorMark(activeReference.value);
  }
  activeReference.value = null;
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
  // Inline anchor click detection — composedPath pierces the shadow DOM.
  document.addEventListener("click", handleDocumentClick);
});

onUnmounted(() => {
  cleanupListeners();
  window.removeEventListener("mousemove", handleMouseMove);
  document.documentElement.removeEventListener("mouseleave", handleMouseLeave);
  window.removeEventListener("scroll", handleThreadReposition, true);
  window.removeEventListener("resize", handleThreadReposition);
  window.removeEventListener("editor-update", handleThreadReposition);
  document.removeEventListener("click", handleDocumentClick);
});

defineExpose({ commentsForOverlays, handleMoveThread });
</script>

<template>
  <div class="contents">
    <!-- Add comment bubble — appears near right viewport edge -->
    <div
      v-if="showAddBubble"
      class="fixed right-4 z-50 -translate-y-1/2 transition-opacity duration-200"
      :class="fadeAddBubble ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'"
      :style="{ top: `${bubbleY}px` }"
    >
      <button
        type="button"
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
        :space-id="spaceId"
        :document-id="documentId"
        :comments="commentsForThread"
        :activeReference="activeReference"
        :isSubmitting="isSubmitting"
        :isDeletingComment="isDeletingComment"
        @submit="handleSubmit"
        @delete="handleDeleteComment"
        @resolve="handleResolve(activeReference)"
        @close="handleCloseThread"
      />
    </div>

    <!-- Thread for new comment (bubble click) -->
    <div
      v-if="addingCommentY !== null && !activeReference"
      class="fixed right-4 z-40"
      :style="{ top: `${addingCommentY}px` }"
    >
      <CommentThread
        :space-id="spaceId"
        :document-id="documentId"
        :comments="[]"
        :activeReference="addingCommentRef"
        :isSubmitting="isSubmitting"
        :isDeletingComment="isDeletingComment"
        @submit="handleSubmitNew"
        @delete="handleDeleteComment"
        @close="addingCommentY = null; addingCommentRef = null"
      />
    </div>

    <!-- Inline anchor click tooltip -->
    <div
      v-if="clickedAnchorRef && !activeReference"
      ref="tooltipEl"
      class="fixed z-40"
      :style="{ top: `${tooltipPos.top}px`, left: `${tooltipPos.left}px` }"
    >
      <CommentThread
        :space-id="spaceId"
        :document-id="documentId"
        :comments="clickedAnchorComments"
        :activeReference="clickedAnchorRef"
        :isSubmitting="isSubmitting"
        :isDeletingComment="isDeletingComment"
        @submit="handleSubmit"
        @delete="handleDeleteComment"
        @resolve="handleResolve(clickedAnchorRef)"
        @close="clickedAnchorRef = null"
      />
    </div>
  </div>
</template>
