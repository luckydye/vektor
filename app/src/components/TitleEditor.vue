<template>
  <div class="flex items-center gap-3 flex-1 px-1 -mx-1">
    <input ref="inputEl" v-if="isEditing" v-model="localTitle" type="text" placeholder="Untitled Document"
      class="text-size-display font-bold text-neutral-900 bg-neutral-50 focus:border-blue-500 outline-none focus:ring-0 flex-1 transition-colors"
      @blur="updateTitle" @keydown.enter="updateTitle" />

    <div v-else :data-document-id="documentId">
        <h1 class="text-size-display font-bold text-neutral-900 flex items-center gap-3 cursor-text text-shadow hover:bg-neutral-50" @dblclick="startEditing">
            {{ localTitle || 'Untitled Document' }}
            <div v-if="starred" class="svg-icon w-6 h-6 text-yellow-500" v-html="starFilledIcon" />
        </h1>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { starFilledIcon } from "~/src/assets/icons.ts";
import { api } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";

const { currentSpaceId, currentSpace } = useSpace();

const props = withDefaults(
  defineProps<{
    title: string;
    documentId?: string;
    starred?: boolean;
    initialEditMode?: boolean;
  }>(),
  {
    starred: false,
    initialEditMode: false,
  },
);

const emit = defineEmits<{
  "title-updated": [title: string];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const localTitle = ref(props.title);
const isEditing = ref(props.initialEditMode);

async function startEditing() {
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
</script>

<style scoped>
input::placeholder {
  color: #9ca3af;
}
</style>
