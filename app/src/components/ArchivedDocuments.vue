<script setup lang="ts">
import { computed } from "vue";
import { api } from "../api/client.ts";
import { formatDate } from "../utils/utils.ts";
import { usePagedList } from "../composeables/usePagedList.ts";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
}>();

const {
  items: documents,
  isLoading,
  isFetching,
  error,
  page,
  totalPages,
  hasPrevPage,
  hasNextPage,
  prevPage,
  nextPage,
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
  ) {
    return;
  }

  try {
    await api.document.delete(props.spaceId, documentId);
    refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete document");
  }
};
</script>

<template>
  <div>
    <div v-if="isLoading" class="text-center py-8">
      <div class="text-neutral">Loading archived documents...</div>
    </div>

    <div v-else-if="error" class="text-center py-8">
      <div class="text-red-600">{{ error?.message ?? 'Failed to load archived documents' }}</div>
    </div>

    <div v-else-if="documents.length === 0" class="text-center py-8">
      <div class="text-neutral">No archived documents</div>
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="doc in documents"
        :key="doc.id"
        class="flex items-center justify-between p-4 bg-background border border-neutral-100 rounded-lg hover:bg-neutral-200"
      >
        <div class="flex-1">
          <a
            :href="`/${spaceSlug}/doc/${doc.slug}`"
            class="text-lg font-medium text-neutral-900 hover:text-blue-600"
          >
            {{ doc.properties.title || "Untitled" }}
          </a>
          <div class="text-sm text-neutral-900 mt-1">
            Archived {{ formatDate(doc.updatedAt) }}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="handleRestore(doc.id)"
            class="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded hover:bg-green-700"
          >
            Restore
          </button>
          <button
            @click="handleDelete(doc.id)"
            class="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700"
          >
            Delete Permanently
          </button>
        </div>
      </div>

      <div v-if="totalPages > 1" class="flex justify-between items-center mt-4 pt-4 border-t border-neutral-100">
        <button
          @click="prevPage"
          :disabled="!hasPrevPage || isFetching"
          class="px-4 py-2 text-sm font-medium border border-neutral-100 rounded-lg hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span class="text-sm text-neutral-500">Page {{ page }} of {{ totalPages }}</span>
        <button
          @click="nextPage"
          :disabled="!hasNextPage || isFetching"
          class="px-4 py-2 text-sm font-medium border border-neutral-100 rounded-lg hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  </div>
</template>
