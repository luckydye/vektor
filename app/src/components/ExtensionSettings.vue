<template>
  <div class="flex-1 flex flex-col">
    <div class="pt-6 space-y-4">
      <!-- Upload Error -->
      <div v-if="uploadError" class="p-3 bg-red-50 border border-red-200 rounded-md">
        <p class="text-size-medium text-red-600">{{ uploadError }}</p>
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" class="text-center py-8 text-size-medium text-neutral">
        Loading extensions...
      </div>

      <!-- Empty State -->
      <div v-else-if="allExtensions.length === 0" class="text-center py-8">
        <p class="text-size-medium text-neutral-900 mb-2">No extensions installed</p>
        <p class="text-size-small text-neutral">Upload a .zip extension package to get started</p>
      </div>

      <!-- Extensions List -->
      <div v-else class="overflow-x-auto border border-neutral-100 rounded-md">
        <table class="min-w-full text-size-medium">
          <thead class="bg-neutral-50">
            <tr>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Extension</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Status</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Version</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Entry Points</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Updated</th>
              <th class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <!-- Valid extensions -->
            <tr v-for="ext in extensions" :key="ext.id" class="hover:bg-neutral-50">
              <td class="px-4 py-2.5">
                <div class="font-medium text-neutral-900">{{ ext.name }}</div>
                <div class="text-size-small text-neutral-500 font-mono">{{ ext.id }}</div>
                <div v-if="ext.description" class="text-size-small text-neutral-500 mt-0.5">{{ ext.description }}</div>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap">
                <SwitchToggle
                  :model-value="ext.enabled"
                  :disabled="isUpdating"
                  :label="ext.enabled ? 'Enabled' : 'Disabled'"
                  @update:model-value="handleToggle(ext.id, $event)"
                />
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-neutral-900 font-mono">{{ ext.version }}</td>
              <td class="px-4 py-2.5">
                <div class="flex flex-wrap gap-1">
                  <span v-if="ext.entries.frontend" class="px-1.5 py-0.5 text-size-small bg-blue-50 text-blue-700 rounded-sm whitespace-nowrap">frontend</span>
                  <span v-if="ext.entries.view" class="px-1.5 py-0.5 text-size-small bg-purple-50 text-purple-700 rounded-sm whitespace-nowrap">view</span>
                  <span v-if="!ext.entries.frontend && !ext.entries.view" class="text-size-small text-neutral-400 italic">None</span>
                </div>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ formatDate(ext.updatedAt) }}</td>
              <td class="px-4 py-2.5 whitespace-nowrap text-right">
                <span class="flex items-center justify-end gap-3">
                  <button
                    @click="downloadPackage(ext.id)"
                    class="text-size-small text-neutral hover:text-neutral-900"
                  >
                    Download
                  </button>
                  <button
                    @click="handleDelete(ext.id)"
                    :disabled="isDeleting"
                    class="text-size-small text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </span>
              </td>
            </tr>
            <!-- Broken extensions -->
            <tr v-for="item in extensionErrors" :key="item.id" class="bg-amber-50 hover:bg-amber-100">
              <td class="px-4 py-2.5">
                <div class="font-mono text-neutral-900">{{ item.id }}</div>
                <div class="text-size-small text-amber-700 mt-0.5">{{ item.error }}</div>
              </td>
              <td class="px-4 py-2.5 text-neutral-400">Invalid</td>
              <td class="px-4 py-2.5 text-neutral-400">—</td>
              <td class="px-4 py-2.5 text-neutral-400">—</td>
              <td class="px-4 py-2.5 text-neutral-400">—</td>
              <td class="px-4 py-2.5 whitespace-nowrap text-right">
                <span class="flex items-center justify-end gap-3">
                  <button
                    @click="downloadPackage(item.id)"
                    class="text-size-small text-neutral hover:text-neutral-900"
                  >
                    Download
                  </button>
                  <button
                    @click="handleDelete(item.id)"
                    :disabled="isDeleting"
                    class="text-size-small text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Upload Section -->
      <div v-if="uploadAllowed" class="flex items-center gap-4">
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
          <span class="text-size-medium text-neutral">
            {{ isUploading ? 'Uploading...' : 'Click to upload extension (.zip)' }}
          </span>
        </label>
      </div>
      <div v-else class="p-3 bg-neutral-50 border border-neutral-200 rounded-md">
        <p class="text-size-medium text-neutral-500">Direct extension uploads are not allowed in this space. Extensions must be installed from the marketplace.</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useExtensions } from "../composeables/useExtensions.ts";
import { config } from "../config.ts";
import SwitchToggle from "./SwitchToggle.vue";

const uploadAllowed = computed(() => {
  const raw = config().EXTENSION_ALLOWED_SOURCES;
  if (!raw) return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes("upload");
});

const {
  extensions,
  extensionErrors,
  isLoading,
  uploadError,
  isUploading,
  isDeleting,
  isUpdating,
  uploadExtension,
  deleteExtension,
  setExtensionEnabled,
  downloadPackage,
} = useExtensions();

const allExtensions = computed(
  () => extensions.value.length + extensionErrors.value.length,
);

async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  await uploadExtension(file);
}

async function handleDelete(extensionId: string) {
  if (!confirm(`Are you sure you want to delete this extension?`)) return;
  await deleteExtension(extensionId);
}

async function handleToggle(extensionId: string, enabled: boolean) {
  await setExtensionEnabled(extensionId, enabled);
}

function formatDate(dateStr: string | Date) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
</script>
