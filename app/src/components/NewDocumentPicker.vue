<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import canvasPreview from "#assets/new-document-picker/canvas-preview.svg?raw";
import databasePreview from "#assets/new-document-picker/database-preview.svg?raw";
import documentPreview from "#assets/new-document-picker/document-preview.svg?raw";
import starterIllustration from "#assets/new-document-picker/starter.svg?raw";
import workflowPreview from "#assets/new-document-picker/workflow-preview.svg?raw";
import { boltIcon, fileTextIcon, imageIcon, tableRowIcon } from "~/src/assets/icons.ts";

const router = useRouter();
const visible = ref(true);

type DocumentType = "document" | "canvas" | "workflow" | "database";

const documentOptions: Array<{
  type: DocumentType;
  title: string;
  description: string;
  icon: string;
  illustration: string;
}> = [
  {
    type: "document",
    title: "Doc",
    description: "Write, organize, and collaborate in a structured document.",
    icon: fileTextIcon,
    illustration: documentPreview,
  },
  {
    type: "canvas",
    title: "Canvas",
    description: "Visualize ideas and connect things on a flexible canvas.",
    icon: imageIcon,
    illustration: canvasPreview,
  },
  {
    type: "workflow",
    title: "Workflow",
    description: "Map steps and automate processes with ease.",
    icon: boltIcon,
    illustration: workflowPreview,
  },
  {
    type: "database",
    title: "Database",
    description: "Organize and manage data in structured tables.",
    icon: tableRowIcon,
    illustration: databasePreview,
  },
];

function focusEditor() {
  const editorEl = document.querySelector("document-view") as HTMLElement | null;
  editorEl?.focus();
}

function selectType(type: DocumentType) {
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
      class="relative z-10 flex justify-center px-xs pt-6 pb-8 pointer-events-none"
      aria-label="Select document type"
    >
      <div
        class="new-document-picker pointer-events-auto w-full max-w-[1120px] opacity-80 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100"
      >
        <div class="flex flex-col items-center text-center mb-8">
          <div
            class="starter-illustration mb-5"
            aria-hidden="true"
            v-html="starterIllustration"
          />
          <h2 class="text-[28px] leading-tight font-semibold text-neutral-900">
            Create your first content
          </h2>
          <p class="mt-2 text-size-large text-neutral-500">
            Choose a format to get started. You can always switch later.
          </p>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 md:gap-4">
          <button
            v-for="option in documentOptions"
            :key="option.type"
            type="button"
            class="group picker-card grid min-h-[154px] grid-cols-[minmax(0,1fr)_minmax(170px,230px)] gap-5 rounded-lg border border-neutral-200 bg-neutral-10 p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 max-sm:grid-cols-1 max-sm:p-4"
            @click="selectType(option.type)"
          >
            <span class="flex min-w-0 items-start gap-4">
              <span
                class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors group-hover:bg-emerald-100"
              >
                <span class="svg-icon h-6 w-6" v-html="option.icon" />
              </span>
              <span class="min-w-0 pt-1">
                <span class="block text-[21px] leading-7 font-semibold text-neutral-900">
                  {{ option.title }}
                </span>
                <span class="mt-1 block max-w-[240px] text-size-medium leading-6 text-neutral-500">
                  {{ option.description }}
                </span>
              </span>
            </span>

            <span
              class="picker-preview"
              aria-hidden="true"
              v-html="option.illustration"
            />
          </button>
        </div>
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

.starter-illustration {
  width: 120px;
  height: 72px;
}

.starter-illustration :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.picker-card {
  cursor: pointer;
}

.picker-preview {
  display: block;
  min-height: 116px;
  overflow: hidden;
}

.picker-preview :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

@media (max-width: 640px) {
  .picker-preview {
    display: none;
  }
}
</style>
