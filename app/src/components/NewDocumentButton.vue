<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Icon } from "~/src/components/index.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { features } from "../config/features.ts";

const isCreating = ref(false);
const showTypeMenu = ref(false);
const menuRef = ref<HTMLElement | null>(null);

const { currentSpace } = useSpace();

const canvasEnabled = computed(() => features.canvas);

function handleCreateDocument(type: "document" | "canvas" = "document") {
  if (!currentSpace.value || isCreating.value) {
    return;
  }

  isCreating.value = true;
  showTypeMenu.value = false;

  window.location.href = `/${currentSpace.value.slug}/new?type=${type}`;
}

function toggleTypeMenu(event: MouseEvent) {
  event.stopPropagation();
  showTypeMenu.value = !showTypeMenu.value;
}

function handleClickOutside(event: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
    showTypeMenu.value = false;
  }
}

onMounted(() => {
  document.addEventListener("click", handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutside);
});
</script>

<template>
  <div ref="menuRef" class="relative">
    <div class="button-primary-base button-with-icon overflow-hidden">
      <button
        type="button"
        class="inline-flex justify-center items-center px-3xs button-primary-pointer"
        :disabled="isCreating"
        @click="handleCreateDocument('document')"
      >
        <Icon name="plus" />
        <span class="@max-sm:hidden">{{ isCreating ? 'Loading...' : 'New Document' }}</span>
      </button>
      <button
        v-if="canvasEnabled"
        type="button"
        class="@max-xs:hidden flex items-center justify-center border-l border-primary-700 px-4xs button-primary-pointer"
        @click="toggleTypeMenu"
      >
        <Icon name="more" />
      </button>
    </div>

    <div
      v-if="showTypeMenu && canvasEnabled"
      class="absolute top-[calc(100%+4px)] right-0 bg-background border border-neutral-100 rounded-lg p-[4px] flex flex-col gap-[4px] min-w-[200px] z-50"
      style="box-shadow: -2px 2px 24px 0px rgba(0, 0, 0, 0.1)"
    >
      <button
        type="button"
        class="w-full text-left px-3xs py-[8px] rounded-md transition-colors hover:bg-primary-10"
        @click="handleCreateDocument('canvas')"
      >
        <div class="font-medium text-size-small">Canvas</div>
        <div class="text-size-small text-neutral-500">Whiteboard with tldraw</div>
      </button>
    </div>
  </div>
</template>
