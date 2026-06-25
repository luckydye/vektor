<script setup lang="ts">
import { onBeforeMount, onBeforeUpdate, onUnmounted } from "vue";
import { useDocumentContext } from "../composeables/useDocument.ts";
import { useEditor } from "../composeables/useEditor.ts";

const props = withDefaults(
  defineProps<{
    documentId?: string;
    documentType?: string;
    readonly?: boolean;
    publishedVersion?: number | null;
    userCanEdit?: boolean;
  }>(),
  {
    documentType: "document",
    readonly: false,
    publishedVersion: null,
    userCanEdit: false,
  },
);

const {
  canUseDocumentEditor,
  documentContext,
  resetDocumentContext,
  setDocumentContext,
} = useDocumentContext();
const { editing, resetEditingState } = useEditor();

function updateDocumentContext() {
  setDocumentContext({
    documentId: props.documentId,
    documentType: props.documentType,
    readonly: props.readonly,
    publishedVersion: props.publishedVersion,
    userCanEdit: props.userCanEdit,
  });

  if (!canUseDocumentEditor.value && editing.value) {
    resetEditingState();
  }
}

onBeforeMount(updateDocumentContext);
onBeforeUpdate(updateDocumentContext);
onUnmounted(() => {
  if (
    documentContext.value.documentId === props.documentId &&
    documentContext.value.documentType === props.documentType
  ) {
    resetDocumentContext();
  }
});
</script>

<template></template>
