<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { boltIcon, fileTextIcon, imageIcon, tableRowIcon } from "~/src/assets/icons.ts";

const router = useRouter();
const visible = ref(true);

function focusEditor() {
  const editorEl = document.querySelector("document-view") as HTMLElement | null;
  editorEl?.focus();
}

function selectType(type: string) {
  if (type === "document") {
    visible.value = false;
    focusEditor();
  } else {
    router.push(`/new?type=${type}`);
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (!visible.value) return;
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    visible.value = false;
    focusEditor();
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown, { capture: true });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown, { capture: true });
});
</script>

<template>
  <Transition name="picker-fade">
    <div
      v-if="visible"
      class="flex items-center justify-center z-10 pointer-events-none absolute top-1/2 left-0 right-0"
      aria-label="Select document type"
    >
      <div class="flex gap-3 pointer-events-auto">
        <button
          @click="selectType('document')"
          class="flex items-center gap-2.5 px-5 py-3 rounded-xl border border-neutral-200 bg-neutral-10 text-neutral-700 text-size-medium font-medium hover:bg-neutral-50 hover:border-neutral-300 transition-colors cursor-pointer select-none shadow-xs"
        >
          <div class="svg-icon w-[18px] h-[18px] text-neutral-500 shrink-0" v-html="fileTextIcon" />
          <span>Doc</span>
        </button>

        <button
          @click="selectType('canvas')"
          class="flex items-center gap-2.5 px-5 py-3 rounded-xl border border-neutral-200 bg-neutral-10 text-neutral-700 text-size-medium font-medium hover:bg-neutral-50 hover:border-neutral-300 transition-colors cursor-pointer select-none shadow-xs"
        >
          <div class="svg-icon w-[18px] h-[18px] text-neutral-500 shrink-0" v-html="imageIcon" />
          <span>Canvas</span>
        </button>

        <button
          @click="selectType('workflow')"
          class="flex items-center gap-2.5 px-5 py-3 rounded-xl border border-neutral-200 bg-neutral-10 text-neutral-700 text-size-medium font-medium hover:bg-neutral-50 hover:border-neutral-300 transition-colors cursor-pointer select-none shadow-xs"
        >
          <div class="svg-icon w-[18px] h-[18px] text-neutral-500 shrink-0" v-html="boltIcon" />
          <span>Workflow</span>
        </button>

        <button
          @click="selectType('database')"
          class="flex items-center gap-2.5 px-5 py-3 rounded-xl border border-neutral-200 bg-neutral-10 text-neutral-700 text-size-medium font-medium hover:bg-neutral-50 hover:border-neutral-300 transition-colors cursor-pointer select-none shadow-xs"
        >
          <div class="svg-icon w-[18px] h-[18px] text-neutral-500 shrink-0" v-html="tableRowIcon" />
          <span>Database</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.picker-fade-enter-active,
.picker-fade-leave-active {
  transition: opacity 0.15s ease;
}

.picker-fade-enter-from,
.picker-fade-leave-to {
  opacity: 0;
}
</style>
