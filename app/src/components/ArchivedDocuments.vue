<script setup lang="ts">
import { computed } from "vue";
import { api } from "../api/client.ts";
import { usePagedList } from "../composeables/usePagedList.ts";
import { formatDate } from "../utils/utils.ts";

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

    <div v-else>
      <div class="overflow-x-auto border border-neutral-100 rounded-md">
        <table class="min-w-full text-size-medium">
          <thead class="bg-neutral-50">
            <tr>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Title</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Archived</th>
              <th class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="doc in documents" :key="doc.id" class="hover:bg-neutral-50">
              <td class="px-4 py-2.5">
                <a :href="`/${spaceSlug}/doc/${doc.slug}`" class="font-medium text-neutral-900 hover:text-blue-600">
                  {{ doc.properties.title || "Untitled" }}
                </a>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ formatDate(doc.updatedAt) }}</td>
              <td class="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
                <button @click="handleRestore(doc.id)" class="text-size-small text-green-600 hover:text-green-800">Restore</button>
                <button @click="handleDelete(doc.id)" class="text-size-small text-red-600 hover:text-red-800">Delete Permanently</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex justify-between items-center mt-3 pt-3 border-t border-neutral-100">
        <button
          @click="prevPage"
          :disabled="!hasPrevPage || isFetching"
          class="px-3 py-1.5 text-size-small font-medium border border-neutral-100 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span class="text-size-small text-neutral-500">Page {{ page }} of {{ totalPages }}</span>
        <button
          @click="nextPage"
          :disabled="!hasNextPage || isFetching"
          class="px-3 py-1.5 text-size-small font-medium border border-neutral-100 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  </div>
</template>
