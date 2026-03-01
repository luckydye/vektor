<script setup lang="ts">
import { ref, watch } from "vue";
import { Input, ButtonPrimary, ButtonSecondary } from "~/src/components/index.ts";
import { checkIcon, closeIcon } from "~/src/assets/icons.ts";
import { slugify } from "../utils/utils.ts";

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
  <div v-if="show" class="fixed inset-0 z-100 flex items-center justify-center bg-black/30 text-white overflow-hidden backdrop-blur-sm" @click.self="handleClose">
    <div class="rounded-lg p-s w-full max-w-md min-w-[250px]">
      <h2 class="text-xl font-semibold text-foreground mb-3xs">Create New Space</h2>

      <form @submit.prevent="handleSubmit" class="flex flex-col gap-3xs">
        <div>
          <label for="space-name" class="block text-small font-medium text-foreground mb-5xs">
            Space Name
          </label>
          <Input v-model="newSpaceName" placeholder="My Wiki" @input="handleNameInput" class="text-black" />
        </div>

        <div>
          <label for="space-slug" class="block text-small font-medium text-foreground mb-5xs">
            Slug
          </label>
          <Input v-model="newSpaceSlug" placeholder="my-wiki" class="text-black" />
          <p class="mt-5xs text-extra-small">
            Only lowercase letters, numbers, and hyphens
          </p>
        </div>

        <div>
          <label for="brand-color" class="block text-small font-medium text-foreground mb-5xs">
            Brand Color
          </label>
          <div class="flex gap-4xs items-center">
            <input id="brand-color" v-model="brandColor" type="color"
              class="h-10 w-20 border border-neutral-100 rounded-md cursor-pointer" />
            <Input v-model="brandColor" placeholder="#42516d" class="flex-1 text-black" />
          </div>
          <p class="mt-5xs text-extra-small">
            Used for the header and sidebar
          </p>
        </div>

        <div class="flex gap-3xs mt-3xs">
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
            @click="handleSubmit"
          />
        </div>
      </form>
    </div>
  </div>
</template>
