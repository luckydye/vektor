<template>
</template>

<script setup lang="ts">
import { Editor } from '@tiptap/core';
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDocument } from "../composeables/useDocument.ts";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import type { ContentEditor } from '~/src/editor/editor';

const user = useUserProfile();

const editor = ref<Editor | undefined>();

const props = defineProps({
  documentId: {
    type: String,
    required: false,
  },
  spaceId: {
    type: String,
    required: true,
  },
  documentType: {
    type: String,
    default: "document",
  },
});

const emit = defineEmits(["editor-ready", "save-status"]);

const { saveStatus, saveError, saveDocument, cancelDebounce } = useDocument(
  props.documentId,
  props.documentType,
);
const { saveRevision } = useRevisions(props.documentId);

async function manualSave() {
  if (editor.value) {
    const content = editor.value.getHTML();
    await saveRevisionSnapshot();
    await saveDocument(content);
  }
}

async function saveRevisionSnapshot() {
  if (editor.value) {
    const html = editor.value.getHTML();
    await saveRevision(html, "Manual save");
  }
}

onMounted(() => {
  emit("editor-ready", manualSave);
  
  window.dispatchEvent(new CustomEvent("document:edit"));

  const editorElement = document.querySelector<ContentEditor>("editor-content");
  editor.value = editorElement?.init(props.spaceId, props.documentId, user.value);
});

watch([saveStatus, saveError], () => {
  emit("save-status", { status: saveStatus.value, error: saveError.value });
  
  window.dispatchEvent(new CustomEvent("document:save"));
});

onBeforeUnmount(() => {
  cancelDebounce();
});
</script>
