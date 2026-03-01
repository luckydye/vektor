<script setup lang="ts">
import { onMounted, ref } from "vue";
import { formatDate } from "../utils/utils.ts";
import { api } from "../api/client.ts";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
}>();

interface ArchivedDocument {
  id: string;
  slug: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  parentId: string | null;
}

const documents = ref<ArchivedDocument[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);

const loadArchivedDocuments = async () => {
  isLoading.value = true;
  error.value = null;

  try {
    const response = await fetch(`/api/v1/spaces/${props.spaceId}/documents/archived`);

    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? "You don't have access to this space"
          : "Failed to load archived documents",
      );
    }

    const data = await response.json();
    documents.value = data.documents;
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : "Failed to load archived documents";
    documents.value = [];
  } finally {
    isLoading.value = false;
  }
};

const handleRestore = async (documentId: string) => {
  try {
    await api.document.restore(props.spaceId, documentId);

    await loadArchivedDocuments();
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
    const response = await fetch(
      `/api/v1/spaces/${props.spaceId}/documents/${documentId}?permanent=true`,
      {
        method: "DELETE",
      },
    );

    if (!response.ok) {
      throw new Error("Failed to delete document");
    }

    await loadArchivedDocuments();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete document");
  }
};

onMounted(() => {
  loadArchivedDocuments();
});
</script>

<template>
  <div>
    <div v-if="isLoading" class="text-center py-8">
      <div class="text-neutral">Loading archived documents...</div>
    </div>

    <div v-else-if="error" class="text-center py-8">
      <div class="text-red-600">{{ error }}</div>
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
            Archived {{ formatDate(new Date(doc.updatedAt)) }}
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
    </div>
  </div>
</template>
