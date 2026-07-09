<script setup lang="ts">
import { computed } from "vue";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import { spinnerIcon, trashIcon } from "~/src/assets/icons.ts";
import DocumentGroupedList from "./DocumentGroupedList.vue";

const props = defineProps<{
  spaceId: string;
}>();

const {
  data: docs,
  isPending: isLoading,
  error,
  refetch,
} = useQuery({
  queryKey: computed(() => ["archived_docs", props.spaceId]),
  queryFn: () =>
    api.documents.archived(props.spaceId, { limit: 500 }).then((r) => r.documents),
});

const { data: categories } = useQuery({
  queryKey: computed(() => ["categories", props.spaceId]),
  queryFn: () => api.categories.get(props.spaceId),
});

async function handleRestore(documentId: string) {
  try {
    await api.document.restore(props.spaceId, documentId);
    refetch();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to restore document");
  }
}

async function handleDelete(documentId: string) {
  if (!confirm("Permanently delete this document? This cannot be undone.")) return;
  try {
    await api.document.delete(props.spaceId, documentId);
    refetch();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete document");
  }
}

async function handleBatchRestore(ids: Set<string>, deselectAll: () => void) {
  const count = ids.size;
  if (!confirm(`Restore ${count} document${count !== 1 ? "s" : ""}?`)) return;
  try {
    for (const id of ids) await api.document.restore(props.spaceId, id);
    deselectAll();
    refetch();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to restore documents");
  }
}

async function handleBatchDelete(ids: Set<string>, deselectAll: () => void) {
  const count = ids.size;
  if (
    !confirm(
      `Permanently delete ${count} document${count !== 1 ? "s" : ""}? This cannot be undone.`,
    )
  )
    return;
  try {
    for (const id of ids) await api.document.delete(props.spaceId, id);
    deselectAll();
    refetch();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete documents");
  }
}
</script>

<template>
  <div>
    <div v-if="isLoading" class="flex flex-col items-center py-12 gap-3">
      <div class="svg-icon w-6 h-6 text-neutral-300 animate-spin" v-html="spinnerIcon" />
      <p class="text-size-small text-neutral-400">Loading archived documents…</p>
    </div>

    <div v-else-if="error" class="py-8 text-center">
      <p class="text-size-small text-red-600">{{ error?.message ?? "Failed to load archived documents" }}</p>
    </div>

    <DocumentGroupedList
      v-else
      :items="docs ?? []"
      :categories="categories"
      empty-text="No archived documents"
    >
      <template #batch-actions="{ selectedIds, deselectAll }">
        <button type="button"
          @click="handleBatchRestore(selectedIds, deselectAll)"
          class="px-3 py-1.5 text-size-small font-medium border border-neutral-200 rounded-md text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50 transition-colors"
        >
          Restore selected
        </button>
        <button type="button"
          @click="handleBatchDelete(selectedIds, deselectAll)"
          class="p-1.5 border border-neutral-200 rounded-md text-neutral-500 hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors"
          title="Delete selected permanently"
        >
          <div class="block svg-icon w-4 h-4" v-html="trashIcon" />
        </button>
      </template>

      <template #row-actions="{ doc }">
        <button type="button"
          @click="handleRestore(doc.id)"
          class="px-2.5 py-1 text-[11px] font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors"
        >
          Restore
        </button>
        <button type="button"
          @click="handleDelete(doc.id)"
          class="p-1 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          title="Delete permanently"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="trashIcon" />
        </button>
      </template>
    </DocumentGroupedList>
  </div>
</template>
