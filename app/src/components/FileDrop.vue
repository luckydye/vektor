<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{
  accept?: string;
  /** Small text shown below the main call-to-action (e.g. accepted formats). */
  hint?: string;
}>();

const emit = defineEmits<{
  select: [file: File];
}>();

const isDragging = ref(false);
const dropZone = ref<HTMLElement | null>(null);
const dropZoneColors = computed(() =>
  isDragging.value
    ? "border-neutral-400 bg-neutral-50"
    : "border-neutral-200 bg-transparent",
);

function isAccepted(file: File): boolean {
  if (!props.accept) return true;
  return props.accept.split(",").some((type) => {
    const t = type.trim();
    if (t.startsWith(".")) return file.name.toLowerCase().endsWith(t.toLowerCase());
    if (t.endsWith("/*")) return file.type.startsWith(t.slice(0, -1));
    return file.type === t;
  });
}

function pick(file: File) {
  if (isAccepted(file)) emit("select", file);
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  isDragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) pick(file);
}

function onDragOver(event: DragEvent) {
  event.preventDefault();
  isDragging.value = true;
}

function onDragLeave(event: DragEvent) {
  if (!dropZone.value?.contains(event.relatedTarget as Node)) {
    isDragging.value = false;
  }
}

function onPaste(event: ClipboardEvent) {
  const file = event.clipboardData?.files?.[0];
  if (file) pick(file);
}

function openPicker() {
  const input = document.createElement("input");
  input.type = "file";
  if (props.accept) input.accept = props.accept;
  input.style.display = "none";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) pick(file);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

defineExpose({ isDragging, openPicker });
</script>

<template>
  <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
  <!-- biome-ignore lint/a11y/useKeyWithClickEvents: This Vue event handler is supplemental to the component's keyboard interaction model. -->
  <div
    ref="dropZone"
    class="relative flex flex-col items-center justify-center gap-3xs rounded-xl border-2 border-dashed px-m py-l transition-colors hover:border-neutral-400 hover:bg-neutral-50"
    :class="dropZoneColors"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @paste="onPaste"
    @click="openPicker"
  >
    <slot :is-dragging="isDragging" :open-picker="openPicker">
      <!-- Default content -->
      <div
        class="flex items-center justify-center w-14 h-14 rounded-full transition-colors"
        :class="isDragging ? 'bg-neutral-200' : 'bg-neutral-100'"
      >
        <Icon name="upload" class="w-7 h-7 text-neutral-500" />
      </div>

      <p class="text-size-normal text-neutral-700 text-center">
        Drag &amp; drop here or
        <button
          type="button"
          class="text-neutral-700 hover:text-neutral-900 font-medium underline-offset-2 hover:underline cursor-pointer"
          @click.stop="openPicker"
        >
          choose file
        </button>
      </p>

      <p v-if="hint" class="text-small text-neutral-400 text-center -mt-1">
        {{ hint }}
      </p>
    </slot>
  </div>
</template>
