<script setup lang="ts">
import { ref } from "vue";
import { useSpace } from "../composeables/useSpace.ts";
import { api } from "../api/client.ts";

const props = defineProps<{
  documentId: string;
}>();

const isLoading = ref(false);
const { currentSpaceId } = useSpace();

const handleRestore = async () => {
  if (!confirm("Are you sure you want to restore this document?")) {
    return;
  }

  if (!currentSpaceId.value) {
    alert("No space selected");
    return;
  }

  isLoading.value = true;

  try {
    await api.document.restore(currentSpaceId.value, props.documentId);

    // Reload the page to update the UI
    window.location.reload();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to restore document");
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <button
    @click="handleRestore"
    :disabled="isLoading"
    class="px-3 py-1 text-sm font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
  >
    {{ isLoading ? "Restoring..." : "Restore" }}
  </button>
</template>
