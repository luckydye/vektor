<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Icon } from "~/src/components/index.ts";
import { useSpace } from "../composeables/useSpace.ts";

const isCreating = ref(false);
const showTypeMenu = ref(false);
const menuRef = ref<HTMLElement | null>(null);

const { currentSpace } = useSpace();

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
    </div>
  </div>
</template>
