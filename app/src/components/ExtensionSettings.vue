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

      <!-- Extensions Grid -->
      <div
        v-else
        class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
      >
        <!-- Valid extensions -->
        <div
          v-for="ext in extensions"
          :key="ext.id"
          class="group relative flex flex-col p-4 border border-neutral-100 rounded-lg hover:border-neutral-200 hover:shadow-sm transition-all"
        >
          <div class="flex items-start justify-between gap-3">
            <div
              class="flex items-center justify-center h-12 w-12 shrink-0 rounded-lg text-white text-size-large font-semibold"
              :style="{ backgroundColor: avatarColor(ext.id) }"
            >
              {{ initial(ext.name) }}
            </div>
            <SwitchToggle
              :model-value="ext.enabled"
              :disabled="isUpdating"
              @update:model-value="handleToggle(ext.id, $event)"
            />
          </div>

          <div class="mt-3 flex-1">
            <h3 class="font-medium text-neutral-900 truncate" :title="ext.name">
              {{ ext.name }}
            </h3>
            <p
              v-if="ext.description"
              class="mt-1 text-size-small text-neutral-500 line-clamp-2"
            >
              {{ ext.description }}
            </p>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-1.5">
            <span
              class="px-1.5 py-0.5 text-size-small bg-neutral-100 text-neutral-600 rounded-sm font-mono whitespace-nowrap"
              >v{{ ext.version }}</span
            >
            <span
              v-if="ext.entries.frontend"
              class="px-1.5 py-0.5 text-size-small bg-blue-50 text-blue-700 rounded-sm whitespace-nowrap"
              >frontend</span
            >
            <span
              v-if="ext.entries.view"
              class="px-1.5 py-0.5 text-size-small bg-purple-50 text-purple-700 rounded-sm whitespace-nowrap"
              >view</span
            >
          </div>

          <div
            class="mt-3 pt-3 border-t border-neutral-100 flex items-center justify-between"
          >
            <span class="text-size-small text-neutral-400"
              >{{ formatDate(ext.updatedAt) }}</span
            >
            <span class="flex items-center gap-3">
              <button
                type="button"
                @click="downloadPackage(ext.id)"
                class="text-size-small text-neutral hover:text-neutral-900"
              >
                Download
              </button>
              <button
                type="button"
                @click="handleDelete(ext.id)"
                :disabled="isDeleting"
                class="text-size-small text-red-600 hover:text-red-800 disabled:opacity-50"
              >
                Delete
              </button>
            </span>
          </div>
        </div>

        <!-- Broken extensions -->
        <div
          v-for="item in extensionErrors"
          :key="item.id"
          class="flex flex-col p-4 border border-amber-200 bg-amber-50 rounded-lg"
        >
          <div class="flex items-start justify-between gap-3">
            <div
              class="flex items-center justify-center h-12 w-12 shrink-0 rounded-lg bg-amber-200 text-amber-800"
            >
              <svg
                class="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke="currentColor"
                role="img"
                aria-label="Invalid extension"
              >
                <title>Invalid extension</title>
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
            </div>
          </div>

          <div class="mt-3 flex-1">
            <h3
              class="font-mono text-size-small text-neutral-900 truncate"
              :title="item.id"
            >
              {{ item.id }}
            </h3>
            <p class="mt-1 text-size-small text-amber-700 line-clamp-2">
              {{ item.error }}
            </p>
          </div>

          <div
            class="mt-3 pt-3 border-t border-amber-200 flex items-center justify-between"
          >
            <span class="text-size-small text-amber-700">Invalid</span>
            <span class="flex items-center gap-3">
              <button
                type="button"
                @click="downloadPackage(item.id)"
                class="text-size-small text-neutral hover:text-neutral-900"
              >
                Download
              </button>
              <button
                type="button"
                @click="handleDelete(item.id)"
                :disabled="isDeleting"
                class="text-size-small text-red-600 hover:text-red-800 disabled:opacity-50"
              >
                Delete
              </button>
            </span>
          </div>
        </div>

        <!-- Upload Card (trailing) -->
        <label
          v-if="uploadAllowed"
          class="flex flex-col items-center justify-center gap-2 p-4 min-h-[168px] border-2 border-dashed border-neutral-100 rounded-lg cursor-pointer text-center hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <input
            type="file"
            accept=".zip,application/zip"
            class="hidden"
            :disabled="isUploading"
            @change="handleFileSelect"
          >
          <div
            class="flex items-center justify-center h-12 w-12 shrink-0 rounded-lg bg-neutral-100 text-neutral-400"
          >
            <svg
              class="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="2"
              stroke="currentColor"
              role="img"
              aria-label="Upload"
            >
              <title>Upload</title>
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 4.5v15m7.5-7.5h-15"
              />
            </svg>
          </div>
          <span class="text-size-medium text-neutral">
            {{ isUploading ? 'Uploading...' : 'Upload extension (.zip)' }}
          </span>
        </label>
      </div>

      <!-- Upload Not Allowed -->
      <div
        v-if="!isLoading && !uploadAllowed"
        class="p-3 bg-neutral-50 border border-neutral-200 rounded-md"
      >
        <p class="text-size-medium text-neutral-500">
          Direct extension uploads are not allowed in this space. Extensions must be
          installed from the marketplace.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useExtensions } from "#composeables/useExtensions.ts";
import { config } from "#config";
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

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

const AVATAR_COLORS = [
  "#e11d48",
  "#db2777",
  "#9333ea",
  "#7c3aed",
  "#4f46e5",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#16a34a",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
];

function avatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatDate(dateStr: string | Date) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
</script>
