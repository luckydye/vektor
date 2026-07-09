<script setup lang="ts">
import { ref, watch } from "vue";
import { slugify } from "#utils/utils.ts";
import { checkIcon, closeIcon } from "~/src/assets/icons.ts";
import { ButtonPrimary, ButtonSecondary, Dialog, Input } from "~/src/components/index.ts";

interface Props {
  show?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
});

const emit = defineEmits<{
  "update:show": [value: boolean];
  create: [data: { name: string; slug: string; brandColor: string }];
}>();

const newSpaceName = ref("");
const newSpaceSlug = ref("");
const brandColor = ref("#42516d");

const handleNameInput = () => {
  newSpaceSlug.value = slugify(newSpaceName.value);
};

const handleClose = () => {
  emit("update:show", false);
};

const isValidSlug = (slug: string) => {
  return /^[a-z0-9-]+$/.test(slug);
};

const isValidHexColor = (color: string) => {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
};

const handleSubmit = () => {
  if (!newSpaceName.value.trim()) {
    alert("Please enter a space name");
    return;
  }

  if (!newSpaceSlug.value.trim()) {
    alert("Please enter a slug");
    return;
  }

  if (!isValidSlug(newSpaceSlug.value)) {
    alert("Slug must contain only lowercase letters, numbers, and hyphens");
    return;
  }

  if (!isValidHexColor(brandColor.value)) {
    alert("Please enter a valid hex color (e.g., #42516d)");
    return;
  }

  emit("create", {
    name: newSpaceName.value.trim(),
    slug: newSpaceSlug.value.trim(),
    brandColor: brandColor.value,
  });
  newSpaceName.value = "";
  newSpaceSlug.value = "";
  brandColor.value = "#42516d";
  handleClose();
};

watch(
  () => props.show,
  (newShow) => {
    if (!newShow) {
      newSpaceName.value = "";
      newSpaceSlug.value = "";
      brandColor.value = "#42516d";
    }
  },
);
</script>

<template>
  <Dialog
    :show="show"
    title="Create New Space"
    @update:show="(v) => { if (!v) handleClose() }"
  >
    <form
      id="create-space-form"
      @submit.prevent="handleSubmit"
      class="flex flex-col gap-3xs"
    >
      <div>
        <label
          for="space-name"
          class="block text-small font-medium text-neutral-900 mb-5xs"
        >
          Space Name
        </label>
        <Input v-model="newSpaceName" placeholder="My Space" @input="handleNameInput" />
      </div>

      <div>
        <label
          for="space-slug"
          class="block text-small font-medium text-neutral-900 mb-5xs"
        >
          Slug
        </label>
        <Input v-model="newSpaceSlug" placeholder="my-wiki" />
        <p class="mt-5xs text-small text-neutral-500">
          Only lowercase letters, numbers, and hyphens
        </p>
      </div>

      <div>
        <label
          for="brand-color"
          class="block text-small font-medium text-neutral-900 mb-5xs"
        >
          Brand Color
        </label>
        <div class="flex gap-4xs items-center">
          <input
            id="brand-color"
            v-model="brandColor"
            type="color"
            class="h-10 w-20 border border-neutral-100 rounded-md cursor-pointer"
          >
          <Input v-model="brandColor" placeholder="#42516d" class="flex-1" />
        </div>
        <p class="mt-5xs text-small text-neutral-500">Used for the header and sidebar</p>
      </div>
    </form>

    <template #footer>
      <div class="flex gap-3xs">
        <ButtonSecondary
          :icon="closeIcon"
          text="Cancel"
          class="flex-1"
          @click="handleClose"
        />
        <ButtonPrimary
          :icon="checkIcon"
          text="Create"
          class="flex-1"
          type="submit"
          form="create-space-form"
        />
      </div>
    </template>
  </Dialog>
</template>
