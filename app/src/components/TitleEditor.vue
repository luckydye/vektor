<template>
  <div class="flex items-center gap-3 flex-1">
    <input ref="inputEl" v-if="isEditing" v-model="localTitle" type="text" placeholder="Untitled Document"
      class="text-3xl font-bold text-neutral-900 bg-transparent focus:border-blue-500 outline-none focus:ring-0 flex-1 transition-colors"
      @blur="updateTitle" @keydown.enter="updateTitle" />

    <div v-else :data-document-id="documentId">
        <h1 class="text-3xl font-bold text-neutral-900 flex items-center gap-3 cursor-text" @dblclick="startEditing">
            {{ localTitle || 'Untitled Document' }}
            <svg v-if="starred" class="w-6 h-6 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
                <path
                d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
        </h1>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useSpace } from "../composeables/useSpace.ts";
import { api } from "../api/client.ts";

const { currentSpaceId, currentSpace } = useSpace();

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  documentId: {
    type: String,
    required: true,
  },
  starred: {
    type: Boolean,
    default: false,
  },
  initialEditMode: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["title-updated"]);

const inputEl = ref(null);
const localTitle = ref(props.title);
const isEditing = ref(props.initialEditMode);

async function startEditing() {
  isEditing.value = true;
  await nextTick();
  inputEl.value?.focus();
}

watch(
  () => props.title,
  (newTitle) => {
    localTitle.value = newTitle;
  },
);

async function updateTitle() {
  if (localTitle.value !== props.title) {
    emit("title-updated", localTitle.value);
    window.dispatchEvent(
      new CustomEvent("title-changed", {
        detail: { title: localTitle.value },
      }),
    );

    // If there's no documentId, store the title for when the document is created
    if (!props.documentId) {
      window.dispatchEvent(
        new CustomEvent("pending-title-changed", {
          detail: { title: localTitle.value },
        }),
      );
      return;
    }

    try {
      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }

      const data = await api.document.patch(currentSpaceId.value, props.documentId, {
        properties: {
          title: {
            value: localTitle.value,
          },
        },
      });

      // Update URL with new slug
      const newSlug = data.slug;
      if (newSlug && currentSpace.value?.slug) {
        const currentPath = window.location.pathname;
        const docPathPattern = new RegExp(`/${currentSpace.value.slug}/doc/[^/]+`);

        if (docPathPattern.test(currentPath)) {
          const newPath = `/${currentSpace.value.slug}/doc/${newSlug}`;
          window.history.replaceState({}, "", newPath);
        }
      }
    } catch (error) {
      console.error("Error saving title:", error);
    }
  }
  isEditing.value = false;
}

function handleEditModeStart() {
  startEditing();
}

function handleEditModeCancel() {
  localTitle.value = props.title;
  isEditing.value = false;
}

onMounted(() => {
  window.addEventListener("edit-mode-start", handleEditModeStart);
  window.addEventListener("edit-mode-cancel", handleEditModeCancel);
});

onUnmounted(() => {
  window.removeEventListener("edit-mode-start", handleEditModeStart);
  window.removeEventListener("edit-mode-cancel", handleEditModeCancel);
});

const status = ref("idle");
const error = ref(null);

function handleSaveStatusChange(event) {
  status.value = event.detail.status;
  error.value = event.detail.error;
}

onMounted(() => {
  window.addEventListener("save-status-changed", handleSaveStatusChange);
});

onUnmounted(() => {
  window.removeEventListener("save-status-changed", handleSaveStatusChange);
});
</script>

<style scoped>
input::placeholder {
  color: #9ca3af;
}
</style>
