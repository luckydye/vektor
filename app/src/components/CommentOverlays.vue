<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  isInlineAnchorReference,
  isPositionReference,
  resolveReferenceSelector,
} from "#composeables/useComments.ts";
import "./AvatarElement.ts";

interface CommentUser {
  id: string;
  name: string | null;
  image: string | null;
}

export interface Comment {
  id: string;
  reference?: string;
  createdBy: string;
  createdByUser?: CommentUser | null;
}

const props = defineProps<{
  comments: Comment[];
}>();

const emit = defineEmits<{
  (e: "move", payload: { reference: string; y: number }): void;
  (e: "positioned"): void;
}>();

const containerEl = ref<HTMLElement | null>(null);
interface CommentParticipant {
  key: string;
  userId: string;
  user: CommentUser | null;
}

interface CommentOverlay {
  top: number;
  count: number;
  reference: string;
  participants: CommentParticipant[];
}

const overlays = ref<CommentOverlay[]>([]);
const MAX_VISIBLE_AVATARS = 3;

function findElement(reference: string, root: Element | ShadowRoot): Element | null {
  // Case 1: Reference is an ID
  const byId =
    root instanceof ShadowRoot
      ? root.getElementById(reference)
      : root.querySelector(`#${reference}`);
  if (byId) return byId;

  // Case 2: Reference is a selector (e.g. "p:nth-of-type(1)")
  try {
    const bySelector = root.querySelector(reference);
    if (bySelector) return bySelector;
  } catch {}

  return null;
}

/** Top of the document content relative to the overlay container. */
function documentViewTop(): number {
  const container = containerEl.value;
  const docView = document.querySelector("document-view");
  if (!container || !docView) return 0;
  return docView.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

function updateOverlays() {
  if (drag.value?.moved) return; // don't snap bubbles back mid-drag

  const container = containerEl.value;
  const docView = document.querySelector("document-view");
  if (!container || !docView) return;

  // Group comments and their distinct authors by reference.
  const commentGroups = new Map<string, Comment[]>();
  props.comments.forEach((c) => {
    if (c.reference) {
      const reference = resolveReferenceSelector(c.reference);
      const group = commentGroups.get(reference) ?? [];
      group.push(c);
      commentGroups.set(reference, group);
    }
  });

  const containerRect = container.getBoundingClientRect();
  const docTop = docView.getBoundingClientRect().top - containerRect.top;
  const searchRoot = docView.shadowRoot ?? docView;

  const newOverlays: CommentOverlay[] = [];

  commentGroups.forEach((comments, reference) => {
    // Inline anchor comments are shown as hover tooltips, not right-edge bubbles.
    if (isInlineAnchorReference(reference)) return;

    const participants = Array.from(
      comments.reduce((byUser, comment) => {
        const userId = comment.createdByUser?.id ?? comment.createdBy;
        // Optimistic comments have no author until the server responds, so their
        // comment id keeps their temporary avatar separate from another pending one.
        const key = userId || comment.id;
        if (!byUser.has(key)) {
          byUser.set(key, {
            key,
            userId,
            user: comment.createdByUser ?? null,
          });
        }
        return byUser;
      }, new Map<string, CommentParticipant>()).values(),
    );
    const overlay = { count: comments.length, reference, participants };

    if (isPositionReference(reference)) {
      // Position references are y offsets relative to the document content
      newOverlays.push({ ...overlay, top: docTop + Number(reference) });
      return;
    }

    const target = findElement(reference, searchRoot);
    if (target) {
      // Calculate top relative to the overlay container
      const top = target.getBoundingClientRect().top - containerRect.top;
      newOverlays.push({ ...overlay, top });
    }
  });

  overlays.value = newOverlays;
  // Consumers that are anchored to a bubble must measure after Vue has moved
  // the bubble in the DOM, rather than during the same scroll frame.
  void nextTick(() => emit("positioned"));
}

function handleResize() {
  requestAnimationFrame(updateOverlays);
}

function openSidebar(reference: string) {
  window.dispatchEvent(
    new CustomEvent("comment:create", {
      detail: { reference },
    }),
  );
}

// --- Drag-to-reposition ---

const drag = ref<{
  reference: string;
  startY: number;
  startTop: number;
  moved: boolean;
} | null>(null);
let suppressClick = false;

const DRAG_THRESHOLD_PX = 4;

function startDrag(e: PointerEvent, overlay: CommentOverlay) {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag.value = {
    reference: overlay.reference,
    startY: e.clientY,
    startTop: overlay.top,
    moved: false,
  };
}

function onDragMove(e: PointerEvent, overlay: CommentOverlay) {
  const d = drag.value;
  if (!d || d.reference !== overlay.reference) return;

  const dy = e.clientY - d.startY;
  if (!d.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;

  d.moved = true;
  overlay.top = d.startTop + dy;
}

function endDrag(overlay: CommentOverlay) {
  const d = drag.value;
  drag.value = null;
  if (!d || d.reference !== overlay.reference || !d.moved) return;

  // Inline anchor references are bound to document text — don't convert to a y-offset.
  if (isInlineAnchorReference(d.reference)) return;

  suppressClick = true;
  const y = Math.max(0, Math.round(overlay.top - documentViewTop()));
  emit("move", { reference: d.reference, y });
}

function handleClick(reference: string) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  openSidebar(reference);
}

watch(() => props.comments, updateOverlays, { deep: true });

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  window.addEventListener("resize", handleResize);
  // The overlay stores positions relative to its container, while document
  // anchors are measured in the viewport. Recalculate on every captured
  // scroll so bubbles stay attached when either the page or a nested pane
  // scrolls.
  window.addEventListener("scroll", handleResize, true);
  // Recompute when the document content grows/shrinks (images loading,
  // entering/leaving edit mode, ...). The container is inset-0, so it
  // tracks the wrapper around the document content.
  if (containerEl.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerEl.value);
  }
  window.addEventListener("editor-update", handleResize);
  handleResize();
});

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
  window.removeEventListener("scroll", handleResize, true);
  window.removeEventListener("editor-update", handleResize);
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div
    ref="containerEl"
    class="absolute inset-0 right-0 pointer-events-none overflow-visible"
  >
    <template v-for="overlay in overlays" :key="overlay.reference">
      <button
        type="button"
        @pointerdown="startDrag($event, overlay)"
        @pointermove="onDragMove($event, overlay)"
        @pointerup="endDrag(overlay)"
        @pointercancel="drag = null"
        @click.stop="handleClick(overlay.reference)"
        data-comment-overlay-bubble="true"
        :data-comment-reference="overlay.reference"
        class="absolute right-0 pointer-events-auto touch-none select-none
               flex items-center min-h-10 px-1 rounded-full
               hover:ring-2 hover:ring-primary-100 hover:text-primary-600
               transition-colors duration-200 z-20"
        :class="drag?.reference === overlay.reference && drag?.moved
          ? 'cursor-grabbing shadow-lg'
          : isInlineAnchorReference(overlay.reference) ? 'cursor-pointer' : 'cursor-grab'"
        :style="{ top: `${overlay.top}px` }"
        :title="`${overlay.count} comment${overlay.count === 1 ? '' : 's'}${isInlineAnchorReference(overlay.reference) ? '' : ' — drag to reposition'}`"
        :aria-label="`View ${overlay.count} comment${overlay.count === 1 ? '' : 's'}`"
      >
        <span class="flex items-center py-1">
          <span
            v-for="(participant, index) in overlay.participants.slice(0, MAX_VISIBLE_AVATARS)"
            :key="participant.key"
            :class="index > 0 ? '-ml-4' : ''"
          >
            <vektor-avatar
              size="36"
              :user-id="participant.userId"
              :user="participant.user"
              class="pointer-events-none"
            />
          </span>
          <span
            v-if="overlay.participants.length > MAX_VISIBLE_AVATARS"
            class="absolute -right-1 -bottom-1 flex h-6 min-w-6 items-center justify-center rounded-full border border-neutral-200 bg-white px-1 text-[10px] font-semibold text-neutral-700 shadow-sm"
          >
            +{{ overlay.participants.length - MAX_VISIBLE_AVATARS }}
          </span>
        </span>
      </button>
    </template>
  </div>
</template>
