<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";

export interface Comment {
  id: string;
  reference?: string;
}

const props = defineProps<{
  comments: Comment[];
}>();

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

function updateOverlays() {
  // Group comments by reference
  const counts = new Map<string, number>();
  props.comments.forEach((c) => {
    if (c.reference) {
      let ref = c.reference;
      if (ref.startsWith("{")) {
        try {
          const parsed = JSON.parse(ref);
          ref = parsed.selector || ref;
        } catch {}
      }
      counts.set(ref, (counts.get(ref) || 0) + 1);
    }
  });

  const newOverlays: typeof overlays.value = [];

  const root = document.querySelector("document-view");
  if (!root) return;

  const containerRect = root.getBoundingClientRect();

  counts.forEach((count, reference) => {
    if (!Number.isNaN(reference)) {
      newOverlays.push({ top: reference as any as number, count, reference });
      return;
    }

    const target = findElement(reference, root);
    if (target) {
      const rect = target.getBoundingClientRect();
      // Calculate top relative to the container component
      const top = rect.top - containerRect.top;
      newOverlays.push({ top, count, reference });
    }
  });

  overlays.value = newOverlays;
}

function handleResize() {
  requestAnimationFrame(updateOverlays);
}

function openSidebar(reference: string | number) {
  window.dispatchEvent(
    new CustomEvent("comment:create", {
      detail: { reference },
    }),
  );
}

watch(() => props.comments, updateOverlays, { deep: true });

onMounted(() => {
  window.addEventListener("resize", handleResize);
});

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
});
</script>

<template>
  <div class="absolute inset-0 right-0 pointer-events-none overflow-visible">
    <template v-for="overlay in overlays" :key="overlay.reference">
      <button
        @click.stop="openSidebar(overlay.reference)"
        class="absolute right-0 pointer-events-auto cursor-pointer
               flex items-center justify-center min-w-[40px] h-[40px] px-1.5 rounded-full
               bg-primary-200 border border-neutral-100
               hover:border-primary-300 hover:ring-2 hover:ring-primary-100 hover:text-primary-600
               transition-color duration-200 z-20"
        :style="{ top: `${overlay.top}px` }"
        title="View comments"
      >
        <span class="text-base font-semibold text-neutral-600">{{ overlay.count }}</span>
      </button>
    </template>
  </div>
</template>
