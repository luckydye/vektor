<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import canvasPreview from "#assets/new-document-picker/canvas-preview.svg?raw";
import databasePreview from "#assets/new-document-picker/database-preview.svg?raw";
import documentPreview from "#assets/new-document-picker/document-preview.svg?raw";
import workflowPreview from "#assets/new-document-picker/workflow-preview.svg?raw";
import { type TranslationKey, t } from "#utils/lang.ts";
import { boltIcon, canvasIcon, databaseIcon, documentIcon } from "~/src/assets/icons.ts";

const router = useRouter();
const route = useRoute();
const visible = ref(true);

type DocumentType = "document" | "canvas" | "workflow" | "database";

const documentOptions: Array<{
  type: DocumentType;
  title: TranslationKey;
  description: TranslationKey;
  icon: string;
  illustration?: string;
}> = [
  {
    type: "document",
    title: "Doc",
    description: "Write, organize, and collaborate in a structured document.",
    icon: documentIcon,
    illustration: documentPreview,
  },
  {
    type: "canvas",
    title: "Canvas",
    description: "Visualize ideas and connect things on a flexible canvas.",
    icon: canvasIcon,
    illustration: canvasPreview,
  },
  {
    type: "workflow",
    title: "Workflow",
    description: "Map steps and automate processes with ease.",
    icon: boltIcon,
  },
  {
    type: "database",
    title: "Database",
    description: "Organize and manage data in structured tables.",
    icon: databaseIcon,
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
    router.push({ path: "/new", query: { ...route.query, type } });
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
      role="dialog"
      class="relative z-10 flex justify-center pt-6 pb-8 pointer-events-none"
      :aria-label="t('Select document type')"
    >
      <div
        class="new-document-picker pointer-events-auto w-full max-w-[1120px] opacity-80 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100"
      >
        <div class="flex flex-col items-center text-center mb-8">
          <p class="mt-2 text-size-large text-neutral-500">
            {{ t("Choose a format to get started.") }}
          </p>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 md:gap-4">
          <button
            v-for="option in documentOptions"
            :key="option.type"
            type="button"
            class="group picker-card grid min-h-[154px] gap-5 rounded-lg border border-neutral-200 bg-neutral-10 p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 max-sm:grid-cols-1 max-sm:p-4"
            @click="selectType(option.type)"
          >
            <span class="flex min-w-0 items-start gap-4">
              <span
                class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 transition-colors group-hover:bg-primary-100"
              >
                <span class="svg-icon h-6 w-6" v-html="option.icon" />
              </span>
              <span class="min-w-0 pt-1">
                <span class="block text-[21px] leading-7 font-semibold text-neutral-900">
                  {{ t(option.title) }}
                </span>
                <span
                  class="mt-1 block max-w-[240px] text-size-medium leading-6 text-neutral-500"
                >
                  {{ t(option.description) }}
                </span>
              </span>
            </span>

            <span
              v-if="option.illustration"
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

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
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

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
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
