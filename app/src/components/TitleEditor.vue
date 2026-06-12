<template>
  <div class="flex items-center gap-3 flex-1">
    <input ref="inputEl" v-if="isEditing" v-model="localTitle" type="text" placeholder="Untitled Document"
      class="text-3xl font-bold text-neutral-900 bg-transparent focus:border-blue-500 outline-none focus:ring-0 flex-1 transition-colors"
      @blur="updateTitle" @keydown.enter="updateTitle" />

    <div v-else :data-document-id="documentId">
        <h1 class="text-3xl font-bold text-neutral-900 flex items-center gap-3 cursor-text text-shadow" @dblclick="startEditing">
            {{ localTitle || 'Untitled Document' }}
            <div v-if="starred" class="svg-icon w-6 h-6 text-yellow-500" v-html="starFilledIcon" />
        </h1>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { starFilledIcon } from "~/src/assets/icons.ts";
import { api } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";

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
