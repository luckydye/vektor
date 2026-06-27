<script setup lang="ts">
import { computed } from "vue";
import { spinnerIcon } from "~/src/assets/icons.ts";
import { api } from "../api/client.ts";
import { usePagedList } from "../composeables/usePagedList.ts";
import DocumentList from "./DocumentList.vue";
import DocumentListItem from "./DocumentListItem.vue";
import Pager from "./Pager.vue";

const props = defineProps<{
  spaceId: string;
}>();

const {
  items: documents,
  isLoading,
  isFetching,
  error,
  page,
  totalPages,
  goToPage,
  refresh,
} = usePagedList({
  queryKey: computed(() => ["archived_docs", props.spaceId]),
  fetcher: ({ limit, offset }) =>
    api.documents.archived(props.spaceId, { limit, offset }).then((r) => ({
      items: r.documents,
      total: r.total,
    })),
  pageSize: 50,
});

const handleRestore = async (documentId: string) => {
  try {
    await api.document.restore(props.spaceId, documentId);
    refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to restore document");
  }
};

const handleDelete = async (documentId: string) => {
  if (
    !confirm(
      "Are you sure you want to permanently delete this document? This action cannot be undone.",
    )
  )
    return;
  try {
    await api.document.delete(props.spaceId, documentId);
    refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete document");
  }
};

const handleBatchRestore = async (ids: Set<string>, deselectAll: () => void) => {
  const count = ids.size;
  if (!confirm(`Restore ${count} document${count !== 1 ? "s" : ""}?`)) return;
  try {
    for (const id of ids) {
      await api.document.restore(props.spaceId, id);
    }
    deselectAll();
    refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to restore documents");
  }
};

const handleBatchDelete = async (ids: Set<string>, deselectAll: () => void) => {
  const count = ids.size;
  if (
    !confirm(
      `Permanently delete ${count} document${count !== 1 ? "s" : ""}? This cannot be undone.`,
    )
  )
    return;
  try {
    for (const id of ids) {
      await api.document.delete(props.spaceId, id);
    }
    deselectAll();
    refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete documents");
  }
};
</script>

<template>
  <div>
    <div v-if="isLoading" class="text-center py-8">
      <div class="svg-icon w-8 h-8 mx-auto mb-3 text-neutral-300 animate-spin" v-html="spinnerIcon" />
      <p class="text-size-medium text-neutral-500">Loading archived documents…</p>
    </div>

    <div v-else-if="error" class="text-center py-8">
      <p class="text-red-600">{{ error?.message ?? "Failed to load archived documents" }}</p>
    </div>

    <div v-else-if="documents.length === 0" class="text-center py-8">
      <p class="text-neutral">No archived documents</p>
    </div>

    <div v-else>
      <DocumentList :items="documents">
        <template #header-label>
          {{ documents.length }} document{{ documents.length !== 1 ? "s" : "" }}
        </template>

        <template #batch-actions="{ selectedIds, deselectAll }">
          <button
            @click="handleBatchRestore(selectedIds, deselectAll)"
            class="flex items-center gap-1.5 px-3 py-1 bg-background border border-neutral-100 rounded-md text-size-small text-green-700 hover:border-green-300 hover:text-green-900 transition-colors"
          >
            Restore
          </button>
          <button
            @click="handleBatchDelete(selectedIds, deselectAll)"
            class="flex items-center gap-1.5 px-3 py-1 bg-background border border-neutral-100 rounded-md text-size-small text-red-700 hover:border-red-300 hover:text-red-900 transition-colors"
          >
            Delete Permanently
          </button>
        </template>

        <template #default="{ selectedIds, toggleSelect, selectable }">
          <DocumentListItem
            v-for="doc in documents"
            :key="doc.id"
            :document="doc"
            :selected="selectedIds.has(doc.id)"
            :selectable="selectable"
            @toggle-select="toggleSelect"
          >
            <template #actions>
              <div class="flex items-center gap-2">
                <button
                  @click.stop="handleRestore(doc.id)"
                  class="text-size-small text-green-600 hover:text-green-800 font-medium"
                >
                  Restore
                </button>
                <button
                  @click.stop="handleDelete(doc.id)"
                  class="text-size-small text-red-600 hover:text-red-800 font-medium"
                >
                  Delete
                </button>
              </div>
            </template>
          </DocumentListItem>
        </template>
      </DocumentList>

      <Pager
        class="mt-3 pt-3"
        :page="page"
        :total-pages="totalPages"
        :disabled="isFetching"
        @change="goToPage"
      />
    </div>
  </div>
</template>
