<script setup lang="ts">
import { ref, watch } from "vue";
import { alertCircleIcon, uploadIcon } from "~/src/assets/icons.ts";
import { useImport } from "../composeables/useImport.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { Actions } from "../utils/actions.ts";
import { t } from "../utils/lang.ts";

const show = ref(false);

const emit = defineEmits<{
  "update:show": [value: boolean];
}>();

const { currentSpace } = useSpace();
const { importing, progress, error, importFiles, resetImport } = useImport();

const fileInput = ref<HTMLInputElement | null>(null);
const showDialog = ref(false);
const dragOver = ref(false);

watch(
  () => show.value,
  (newValue) => {
    if (!newValue) {
      resetImport();
      showDialog.value = false;
      if (fileInput.value) {
        fileInput.value.value = "";
      }
    }
  },
);

function openFileDialog() {
  fileInput.value?.click();
}

function closeOverlay() {
  show.value = false;
}

function closeAll() {
  showDialog.value = false;
  show.value = false;
}

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];

  if (!file || !currentSpace.value) {
    return;
  }

  await handleImport(file);
}

async function handleDrop(event: DragEvent) {
  dragOver.value = false;
  event.preventDefault();

  const file = event.dataTransfer?.files[0];
  if (!file || !currentSpace.value) {
    return;
  }

  await handleImport(file);
}

async function handleImport(file: File) {
  if (!currentSpace.value) {
    return;
  }

  try {
    await importFiles(currentSpace.value.id, file);
    showDialog.value = true;
  } catch (err) {
    console.error("Import failed:", err);
    showDialog.value = true;
  }
}

function handleDragOver(event: DragEvent) {
  event.preventDefault();
  dragOver.value = true;
}

function handleDragLeave() {
  dragOver.value = false;
}

function getSupportedFilesText(): string {
  return "Supported: WIF (.wif.zip, .zip) format only";
}

Actions.register("import:toggle", {
  title: t("Import"),
  icon: () => "import",
  description: t("Open or close the import menu"),
  run: async () => {
    show.value = !show.value;
  },
});
</script>

<template>
  <a-blur v-if="show" @exit="closeAll" enabled class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
    <div
      class="bg-background rounded-lg shadow-2xl max-w-lg w-full mx-4 p-8"
      @click.stop
      @drop="handleDrop"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
    >
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-size-title font-bold text-neutral-900">Import WIF Archive</h2>
        <button @click="closeOverlay" class="text-neutral hover:text-neutral text-size-display leading-none w-8 h-8 flex items-center justify-center">
          ×
        </button>
      </div>

      <div
        :class="[
          'border-2 border-dashed rounded-lg p-12 text-center transition-colors',
          dragOver ? 'border-blue-600 bg-blue-50' : 'border-neutral-100 bg-neutral-50'
        ]"
      >
        <div class="svg-icon w-12 h-12 mx-auto mb-4 text-blue-600" v-html="uploadIcon" />

        <p class="text-size-title font-semibold text-neutral-900 mb-2">
          {{ dragOver ? 'Drop file here' : 'Drag and drop a file or' }}
        </p>

        <button
          @click="openFileDialog"
          :disabled="importing || !currentSpace"
          class="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-md text-size-medium font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <div class="svg-icon w-4 h-4" v-html="uploadIcon" />
          <span v-if="importing">Importing...</span>
          <span v-else>Choose File</span>
        </button>

        <p class="text-size-medium text-neutral-900 mt-4">
          {{ getSupportedFilesText() }}
        </p>

        <input
          ref="fileInput"
          type="file"
          @change="handleFileSelect"
          accept=".zip,.wif.zip"
          class="hidden"
        />
      </div>
    </div>

    <!-- Results Dialog -->
    <div v-if="showDialog" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" @click="closeAll">
      <div class="bg-background rounded-lg shadow-2xl max-w-[800px] w-full max-h-[80vh] overflow-hidden flex flex-col mx-4" @click.stop>
        <div class="flex items-center justify-between px-6 py-4 border-b border-neutral">
          <h3 class="text-size-large font-semibold text-neutral-900">Import Results</h3>
          <button @click="closeAll" class="text-neutral hover:text-neutral text-size-display leading-none w-8 h-8 flex items-center justify-center">
            &times;
          </button>
        </div>

        <div v-if="error" class="px-6 py-6 flex items-center gap-4 text-red-600">
          <div class="svg-icon w-6 h-6 flex-shrink-0" v-html="alertCircleIcon" />
          <p>{{ error }}</p>
        </div>

        <div v-else-if="progress" class="px-6 py-6 overflow-y-auto flex-1">
          <div class="grid grid-cols-4 gap-4 mb-6">
            <div class="text-center p-4 bg-neutral-300 rounded-lg">
              <span class="block text-size-display font-bold text-neutral-900">{{ progress.totalFiles }}</span>
              <span class="block text-size-small uppercase tracking-wide text-neutral-900 mt-1">Total Files</span>
            </div>
            <div class="text-center p-4 bg-green-50 rounded-lg">
              <span class="block text-size-display font-bold text-green-600">{{ progress.imported }}</span>
              <span class="block text-size-small uppercase tracking-wide text-neutral-900 mt-1">Imported</span>
            </div>
            <div class="text-center p-4 bg-yellow-50 rounded-lg">
              <span class="block text-size-display font-bold text-yellow-600">{{ progress.skipped }}</span>
              <span class="block text-size-small uppercase tracking-wide text-neutral-900 mt-1">Skipped</span>
            </div>
            <div class="text-center p-4 bg-red-50 rounded-lg">
              <span class="block text-size-display font-bold text-red-600">{{ progress.failed }}</span>
              <span class="block text-size-small uppercase tracking-wide text-neutral-900 mt-1">Failed</span>
            </div>
          </div>

          <div v-if="progress.documents.length > 0" class="mt-6">
            <h4 class="text-size-small font-semibold uppercase tracking-wide text-neutral-900 mb-3">Created Documents</h4>
            <ul class="space-y-0">
              <li v-for="doc in progress.documents" :key="doc.id" class="py-2 border-b border-neutral-100 last:border-b-0">
                <a :href="`/spaces/${currentSpace?.slug}/docs/${doc.slug}`" class="text-blue-600 hover:underline font-medium">
                  {{ doc.title }}
                </a>
              </li>
            </ul>
          </div>

          <div v-if="progress.errors.length > 0" class="mt-6">
            <h4 class="text-size-small font-semibold uppercase tracking-wide text-neutral-900 mb-3">Errors</h4>
            <ul class="space-y-0">
              <li v-for="(err, idx) in progress.errors" :key="idx" class="py-2 border-b border-neutral-100 last:border-b-0 text-size-medium text-red-600">
                <strong>{{ err.file }}:</strong> {{ err.error }}
              </li>
            </ul>
          </div>
        </div>

        <div class="px-6 py-4 border-t border-neutral-100 flex justify-end">
          <button @click="closeAll" class="px-6 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  </a-blur>
</template>
