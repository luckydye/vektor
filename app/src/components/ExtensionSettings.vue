<template>
  <div class="flex-1 flex flex-col">
    <div>
      <h3 class="text-lg font-semibold text-neutral-900">Extensions</h3>
      <p class="text-sm text-neutral-900 mt-1">Install and manage extensions to add functionality</p>
    </div>

    <div class="pt-6 space-y-4">
      <!-- Upload Section -->
      <div class="flex items-center gap-4">
        <label
          class="flex-1 flex items-center justify-center px-4 py-3 border-2 border-dashed border-neutral-100 rounded-md cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <input
            type="file"
            accept=".zip,application/zip"
            class="hidden"
            :disabled="isUploading"
            @change="handleFileSelect"
          />
          <span class="text-sm text-neutral">
            {{ isUploading ? 'Uploading...' : 'Click to upload extension (.zip)' }}
          </span>
        </label>
      </div>

      <!-- Error Display -->
      <div v-if="uploadError" class="p-3 bg-red-50 border border-red-200 rounded-md">
        <p class="text-sm text-red-600">{{ uploadError }}</p>
      </div>

      <div
        v-if="extensionErrors.length > 0"
        class="p-3 bg-amber-50 border border-amber-200 rounded-md"
      >
        <p class="text-sm text-amber-800 font-medium mb-1">
          Some installed extensions could not be loaded:
        </p>
        <ul class="text-xs text-amber-800 space-y-0.5">
          <li v-for="item in extensionErrors" :key="`${item.id}:${item.error}`">
            <span class="font-mono">{{ item.id }}</span>: {{ item.error }}
          </li>
        </ul>
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" class="text-center py-8 text-sm text-neutral">
        Loading extensions...
      </div>

      <!-- Empty State -->
      <div v-else-if="!extensions || extensions.length === 0" class="text-center py-8">
        <p class="text-sm text-neutral-900 mb-2">No extensions installed</p>
        <p class="text-xs text-neutral">Upload a .zip extension package to get started</p>
      </div>

      <!-- Extensions List -->
      <div v-else class="overflow-x-auto border border-neutral-100 rounded-md">
        <table class="min-w-full divide-y divide-neutral background">
          <thead class="bg-neutral-200">
            <tr>
              <th
                scope="col"
                class="py-3 pl-4 pr-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wide"
              >
                Extension
              </th>
              <th
                scope="col"
                class="px-3 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wide"
              >
                Version
              </th>
              <th
                scope="col"
                class="px-3 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wide"
              >
                Entry Points
              </th>
              <th
                scope="col"
                class="px-3 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wide"
              >
                Updated
              </th>
              <th
                scope="col"
                class="relative py-3 pl-3 pr-4 text-right text-xs font-medium text-neutral-900 uppercase tracking-wide"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral">
            <tr v-for="ext in extensions" :key="ext.id" class="hover:bg-neutral-200">
              <td class="py-3 pl-4 pr-3">
                <div class="text-sm font-medium text-neutral-900">{{ ext.name }}</div>
                <div class="text-xs text-neutral font-mono">{{ ext.id }}</div>
                <div v-if="ext.description" class="text-xs text-neutral mt-1">{{ ext.description }}</div>
              </td>
              <td class="whitespace-nowrap px-3 py-3 text-sm text-neutral-900 font-mono">
                {{ ext.version }}
              </td>
              <td class="px-3 py-3 text-sm">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-if="ext.entries.frontend"
                    class="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded whitespace-nowrap"
                  >
                    frontend
                  </span>
                  <span
                    v-if="!ext.entries.frontend"
                    class="text-xs text-neutral italic"
                  >
                    None
                  </span>
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-3 text-sm text-neutral">
                {{ formatDate(ext.updatedAt) }}
              </td>
              <td class="whitespace-nowrap py-3 pl-3 pr-4 text-right text-sm">
                <button
                  @click="handleDelete(ext.id)"
                  :disabled="isDeleting"
                  class="text-red-600 hover:text-red-800 text-xs font-medium disabled:opacity-50"
                >
                  Delete
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useExtensions } from "../composeables/useExtensions.ts";

const {
  extensions,
  extensionErrors,
  isLoading,
  uploadError,
  isUploading,
  isDeleting,
  uploadExtension,
  deleteExtension,
} = useExtensions();

async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  // Reset the input immediately so the same file can be selected again
  input.value = "";

  if (!file) {
    return;
  }

  await uploadExtension(file);
}

async function handleDelete(extensionId: string) {
  if (!confirm(`Are you sure you want to delete this extension?`)) {
    return;
  }

  await deleteExtension(extensionId);
}

function formatDate(dateStr: string | Date) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
</script>
