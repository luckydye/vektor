<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { uploadIcon } from "~/src/assets/icons.ts";
import { Icon } from "~/src/components/index.ts";

const props = withDefaults(
  defineProps<{
    accept?: string;
    hint?: string;
    /** Listen for paste events on the window. */
    listenPaste?: boolean;
  }>(),
  {
    listenPaste: true,
  },
);

const emit = defineEmits<{
  select: [file: File];
}>();

const isDragging = ref(false);
const dropZone = ref<HTMLElement | null>(null);

function isAccepted(file: File): boolean {
  if (!props.accept) return true;
  return props.accept.split(",").some((type) => {
    const t = type.trim();
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

onMounted(() => {
  if (props.listenPaste) window.addEventListener("paste", onPaste);
});
onUnmounted(() => {
  window.removeEventListener("paste", onPaste);
});

defineExpose({ isDragging });
</script>

<template>
  <div
    ref="dropZone"
    role="button"
    tabindex="0"
    class="flex flex-col items-center justify-center gap-3xs rounded-md border-2 border-dashed p-l cursor-pointer transition-colors select-none outline-none"
    :class="
      isDragging
        ? 'border-accent bg-accent/10'
        : 'border-neutral-300 hover:border-neutral-400 hover:bg-neutral-50/5 focus-visible:border-accent'
    "
    @click="openPicker"
    @keydown.enter.space.prevent="openPicker"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <slot :is-dragging="isDragging">
      <Icon :icon="uploadIcon" class="text-foreground-secondary w-8 h-8" />
      <p v-if="hint" class="text-small text-foreground-secondary text-center">{{ hint }}</p>
    </slot>
  </div>
</template>
