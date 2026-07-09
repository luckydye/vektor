<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import {
  isInlineAnchorReference,
  isPositionReference,
  resolveReferenceSelector,
} from "#utils/commentReference.ts";

export interface Comment {
  id: string;
  reference?: string;
}

const props = defineProps<{
  comments: Comment[];
}>();

const emit =
  defineEmits<(e: "move", payload: { reference: string; y: number }) => void>();

const containerEl = ref<HTMLElement | null>(null);
const overlays = ref<{ top: number; count: number; reference: string }[]>([]);

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

  // Group comments by reference
  const counts = new Map<string, number>();
  props.comments.forEach((c) => {
    if (c.reference) {
      const ref = resolveReferenceSelector(c.reference);
      counts.set(ref, (counts.get(ref) || 0) + 1);
    }
  });

  const containerRect = container.getBoundingClientRect();
  const docTop = docView.getBoundingClientRect().top - containerRect.top;
  const searchRoot = docView.shadowRoot ?? docView;

  const newOverlays: typeof overlays.value = [];

  counts.forEach((count, reference) => {
    // Inline anchor comments are shown as hover tooltips, not right-edge bubbles.
    if (isInlineAnchorReference(reference)) return;

    if (isPositionReference(reference)) {
      // Position references are y offsets relative to the document content
      newOverlays.push({ top: docTop + Number(reference), count, reference });
      return;
    }

    const target = findElement(reference, searchRoot);
    if (target) {
      // Calculate top relative to the overlay container
      const top = target.getBoundingClientRect().top - containerRect.top;
      newOverlays.push({ top, count, reference });
    }
  });

  overlays.value = newOverlays;
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

function startDrag(e: PointerEvent, overlay: { reference: string; top: number }) {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag.value = {
    reference: overlay.reference,
    startY: e.clientY,
    startTop: overlay.top,
    moved: false,
  };
}

function onDragMove(e: PointerEvent, overlay: { reference: string; top: number }) {
  const d = drag.value;
  if (!d || d.reference !== overlay.reference) return;

  const dy = e.clientY - d.startY;
  if (!d.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;

  d.moved = true;
  overlay.top = d.startTop + dy;
}

function endDrag(overlay: { reference: string; top: number }) {
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
      <button type="button"
        @pointerdown="startDrag($event, overlay)"
        @pointermove="onDragMove($event, overlay)"
        @pointerup="endDrag(overlay)"
        @pointercancel="drag = null"
        @click.stop="handleClick(overlay.reference)"
        data-comment-overlay-bubble="true"
        :data-comment-reference="overlay.reference"
        class="absolute right-0 pointer-events-auto touch-none select-none
               flex items-center justify-center min-w-[40px] h-[40px] px-1.5 rounded-full
               bg-primary-200 border border-neutral-100
               hover:border-primary-300 hover:ring-2 hover:ring-primary-100 hover:text-primary-600
               transition-colors duration-200 z-20"
        :class="drag?.reference === overlay.reference && drag?.moved
          ? 'cursor-grabbing shadow-lg'
          : isInlineAnchorReference(overlay.reference) ? 'cursor-pointer' : 'cursor-grab'"
        :style="{ top: `${overlay.top}px` }"
        :title="isInlineAnchorReference(overlay.reference) ? 'View comments' : 'View comments — drag to reposition'"
      >
        <span class="text-base font-semibold text-neutral-600">{{ overlay.count }}</span>
      </button>
    </template>
  </div>
</template>
