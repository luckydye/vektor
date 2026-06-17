<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { closeSmallIcon, paperclipIcon, sendPlaneIcon } from "~/src/assets/icons.ts";

export type PendingAttachment = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
};

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    rows?: number;
    autofocus?: boolean;
    autoGrow?: boolean;
    submitKey?: "enter" | "ctrl+enter";
    /** Externally disabled — blocks submit regardless of content (e.g. isGenerating, isUploading) */
    disabled?: boolean;
    /** Enable file attachment UI (drag-drop, paste, picker, previews) */
    attachments?: boolean;
    /** Show "Uploading files…" status (set by parent during API upload) */
    isUploading?: boolean;
    /** Upload error message from parent */
    uploadError?: string;
  }>(),
  {
    placeholder: "",
    rows: 1,
    autofocus: false,
    autoGrow: false,
    submitKey: "enter",
    disabled: false,
    attachments: false,
    isUploading: false,
    uploadError: "",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [];
  keydown: [event: KeyboardEvent];
  keyup: [event: KeyboardEvent];
  input: [event: Event];
  click: [event: MouseEvent];
  paste: [event: ClipboardEvent];
}>();

defineSlots<{
  left(): unknown;
  actions(): unknown;
  below(): unknown;
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const pendingAttachments = ref<PendingAttachment[]>([]);

const canSubmit = computed(
  () =>
    !props.disabled &&
    (props.modelValue.trim().length > 0 || pendingAttachments.value.length > 0),
);

function focus() {
  textareaRef.value?.focus();
}

// ── File management ───────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openFilePicker() {
  fileInputRef.value?.click();
}

function revokePreviewUrl(url?: string) {
  if (url) URL.revokeObjectURL(url);
}

function clearAttachments() {
  for (const a of pendingAttachments.value) revokePreviewUrl(a.previewUrl);
  pendingAttachments.value = [];
}

function removeAttachment(id: string) {
  const idx = pendingAttachments.value.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const [removed] = pendingAttachments.value.splice(idx, 1);
  revokePreviewUrl(removed.previewUrl);
}

function addFiles(fileList: FileList) {
  const next: PendingAttachment[] = [];
  for (const file of Array.from(fileList)) {
    next.push({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    });
  }
  pendingAttachments.value = [...pendingAttachments.value, ...next];
}

function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  addFiles(input.files);
  input.value = "";
}

function onDrop(event: DragEvent) {
  if (!props.attachments || !event.dataTransfer?.files?.length || props.disabled) return;
  event.preventDefault();
  addFiles(event.dataTransfer.files);
}

// ── Input events ──────────────────────────────────────────────────────────────

function onKeydown(event: KeyboardEvent) {
  emit("keydown", event);
  if (event.defaultPrevented) return;

  const isEnterNoShift = event.key === "Enter" && !event.shiftKey;
  const isCtrlEnter = event.key === "Enter" && event.ctrlKey;

  if (
    (props.submitKey === "enter" && isEnterNoShift) ||
    (props.submitKey === "ctrl+enter" && isCtrlEnter)
  ) {
    event.preventDefault();
    if (canSubmit.value) emit("submit");
  }
}

function onPaste(event: ClipboardEvent) {
  if (props.attachments && !props.disabled && event.clipboardData?.files?.length) {
    addFiles(event.clipboardData.files);
  }
  emit("paste", event);
}

onMounted(() => {
  if (props.autofocus) nextTick(() => textareaRef.value?.focus());
});

onUnmounted(() => {
  for (const a of pendingAttachments.value) revokePreviewUrl(a.previewUrl);
});

defineExpose({
  focus,
  clearAttachments,
  removeAttachment,
  pendingAttachments,
  get el() {
    return textareaRef.value;
  },
});
</script>

<template>
  <div @dragover.prevent @drop="onDrop">
    <input
      v-if="attachments"
      ref="fileInputRef"
      type="file"
      multiple
      class="hidden"
      @change="onFilesSelected"
    />

    <!-- Pending attachment previews -->
    <div v-if="attachments && pendingAttachments.length > 0" class="mb-2 flex flex-wrap gap-1.5">
      <div
        v-for="attachment in pendingAttachments"
        :key="attachment.id"
        class="group flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-10 px-1.5 py-1"
      >
        <img
          v-if="attachment.previewUrl"
          :src="attachment.previewUrl"
          :alt="attachment.name"
          class="h-8 w-8 rounded-sm object-cover"
        />
        <div
          v-else
          class="h-8 w-8 rounded-sm bg-neutral-200 text-neutral-500 flex items-center justify-center text-[10px] font-semibold"
        >
          FILE
        </div>
        <div class="min-w-0 max-w-36">
          <p class="truncate text-size-small text-neutral-700">{{ attachment.name }}</p>
          <p class="text-[10px] text-neutral-500">{{ formatFileSize(attachment.size) }}</p>
        </div>
        <button
          type="button"
          class="text-neutral-400 hover:text-red-500 transition-colors"
          @click="removeAttachment(attachment.id)"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="closeSmallIcon" />
        </button>
      </div>
    </div>

    <!-- Input row -->
    <div class="flex items-end gap-2">
      <button
        v-if="attachments"
        type="button"
        title="Attach files"
        class="shrink-0 text-neutral-400 hover:text-neutral-700 transition-colors mb-0.5"
        @click="openFilePicker"
      >
        <div class="svg-icon w-4 h-4" v-html="paperclipIcon" />
      </button>

      <slot name="left" />

      <textarea
        ref="textareaRef"
        :value="modelValue"
        :placeholder="placeholder"
        :rows="rows"
        :style="autoGrow ? 'field-sizing: content' : undefined"
        :class="autoGrow ? 'max-h-40' : ''"
        class="flex-1 bg-transparent text-size-medium text-neutral-800 placeholder-neutral-400 focus:outline-none resize-none leading-5"
        @input="
          emit('update:modelValue', ($event.target as HTMLTextAreaElement).value);
          emit('input', $event);
        "
        @click="emit('click', $event)"
        @keyup="emit('keyup', $event)"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <slot name="actions">
        <button
          type="button"
          :disabled="!canSubmit"
          class="shrink-0 text-neutral-500 hover:text-primary-500 disabled:opacity-40 transition-colors mb-0.5"
          title="Send"
          @click="emit('submit')"
        >
          <div class="svg-icon w-4 h-4" v-html="sendPlaneIcon" />
        </button>
      </slot>
    </div>

    <!-- Upload status (controlled by parent) -->
    <template v-if="attachments">
      <p v-if="isUploading" class="mt-2 text-size-small text-neutral-500">Uploading files...</p>
      <p v-if="uploadError" class="mt-2 text-size-small text-red-600">{{ uploadError }}</p>
    </template>

    <slot name="below" />
  </div>
</template>
