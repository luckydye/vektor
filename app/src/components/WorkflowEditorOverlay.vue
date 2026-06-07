<script setup lang="ts">
const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();
</script>

<template>
  <DockedPanel
    id="workflow-editor"
    title="Workflow Editor"
    default-side="right"
    :default-width="720"
    default-mode="floating"
  >
    <div class="flex flex-col h-full bg-white">
      <WorkflowNodeEditor
        class="flex-1 min-h-0"
        :document-id="props.documentId"
        :space-id="props.spaceId"
      />
    </div>
  </DockedPanel>
</template>
