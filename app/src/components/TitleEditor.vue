<template>
  <div class="flex items-center gap-3 flex-1 -ml-1">
    <input
      ref="inputEl"
      v-if="isEditing"
      v-model="localTitle"
      type="text"
      placeholder="Untitled Document"
      class="text-size-display font-bold text-neutral-900 bg-neutral-50 focus:border-blue-500 outline-none focus:ring-0 flex-1 transition-colors px-1"
      @blur="updateTitle"
      @keydown.enter="updateTitle"
    >

    <div v-else :data-document-id="documentId">
      <h1
        class="text-size-display font-bold text-neutral-900 flex items-center gap-3 px-1"
        :class="{ 'cursor-text hover:bg-neutral-50': canEdit, 'cursor-default': !canEdit }"
        @dblclick="canEdit && startEditing()"
      >
        {{ localTitle || 'Untitled Document' }}
        <div
          v-if="starred"
          class="svg-icon w-6 h-6 text-yellow-500"
          v-html="starFilledIcon"
        />
      </h1>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { replaceBrowserUrl } from "#utils/browserHistory.ts";
import { spacePath } from "#utils/utils.ts";
import { starFilledIcon } from "~/src/assets/icons.ts";

const { currentSpace } = useSpace();

const props = withDefaults(
  defineProps<{
    title: string;
    spaceId?: string;
    documentId?: string;
    starred?: boolean;
    initialEditMode?: boolean;
    canEdit?: boolean;
  }>(),
  {
    starred: false,
    initialEditMode: false,
    canEdit: false,
  },
);

const emit = defineEmits<{
  "title-updated": [title: string];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const localTitle = ref(props.title);
const isEditing = ref(props.initialEditMode && props.canEdit);

async function startEditing() {
  if (!props.canEdit) return;
  isEditing.value = true;
  await nextTick();
  inputEl.value?.focus({ preventScroll: true });
}

watch(
  () => props.title,
  (newTitle) => {
    localTitle.value = newTitle;
  },
);

async function updateTitle() {
  if (localTitle.value !== props.title) {
    if (!props.canEdit) {
      localTitle.value = props.title;
      isEditing.value = false;
      return;
    }
    emit("title-updated", localTitle.value);
    window.dispatchEvent(
      new CustomEvent("title-changed", {
        detail: { title: localTitle.value },
      }),
    );

    if (!props.documentId) {
      window.dispatchEvent(
        new CustomEvent("pending-title-changed", {
          detail: { title: localTitle.value },
        }),
      );
      return;
    }

    try {
      if (!props.spaceId) throw new Error("No space selected");

      const data = await api.document.patch(props.spaceId, props.documentId, {
        properties: {
          title: {
            value: localTitle.value,
          },
        },
      });

      const newSlug = data.slug;
      if (newSlug) {
        const currentPath = window.location.pathname;
        if (/\/doc\/[^/]+/.test(currentPath)) {
          replaceBrowserUrl(spacePath(currentSpace.value?.slug, `/doc/${newSlug}`));
        }
      }
    } catch (error) {
      console.error("Error saving title:", error);
    }
  }
  isEditing.value = false;
}
</script>

<style scoped>
input::placeholder {
  color: #9ca3af;
}
</style>
