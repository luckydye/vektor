<script setup lang="ts">
import { ref } from "vue";
import { uploadFileIcon } from "#assets/icons.ts";
import { t } from "#utils/lang.ts";
import ClientOnly from "./ClientOnly.vue";

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{
  select: [file: File];
}>();

const isDraggingFile = ref(false);

function containsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function handleDragEnter(event: DragEvent) {
  if (props.disabled || !containsFiles(event)) return;
  event.preventDefault();
  isDraggingFile.value = true;
}

function handleDragOver(event: DragEvent) {
  if (props.disabled || !containsFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  isDraggingFile.value = true;
}

function handleDragLeave(event: DragEvent) {
  const dropTarget = event.currentTarget as HTMLElement | null;
  const nextTarget = event.relatedTarget as Node | null;
  if (!dropTarget || !nextTarget || !dropTarget.contains(nextTarget)) {
    isDraggingFile.value = false;
  }
}

function handleDrop(event: DragEvent) {
  if (props.disabled || !containsFiles(event)) return;
  event.preventDefault();
  isDraggingFile.value = false;

  const file = event.dataTransfer?.files?.[0];
  if (file) emit("select", file);
}
</script>

<template>
  <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
  <div
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <slot />

    <ClientOnly>
      <Teleport to="body">
        <inset-view
          :hidden="!isDraggingFile"
          class="overlay-fade pointer-events-none fixed inset-xs z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary-300 bg-background/95 shadow-large backdrop-blur-sm md:left-[calc(var(--inset-left,0px)+var(--spacing-xs))] md:right-[calc(var(--inset-right,0px)+var(--spacing-xs))]"
        >
          <div class="flex flex-col items-center gap-xs text-center text-primary-700">
            <div
              class="svg-icon h-12 w-12 rounded-full bg-primary-50 p-3xs"
              v-html="uploadFileIcon"
            />
            <p class="text-size-large font-semibold">{{ t("Drop file to upload") }}</p>
          </div>
        </inset-view>
      </Teleport>
    </ClientOnly>
  </div>
</template>
