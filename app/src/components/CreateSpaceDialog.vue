<script setup lang="ts">
import { ref, watch } from "vue";
import { slugify } from "#utils/utils.ts";
import Dialog from "./Dialog.vue";
import DialogFooter from "./DialogFooter.vue";
import SpaceProfileCard from "./SpaceProfileCard.vue";

interface Props {
  show?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
});

const emit = defineEmits<{
  "update:show": [value: boolean];
  create: [data: { name: string; slug: string; brandColor: string; logoSvg: string }];
}>();

const newSpaceName = ref("");
const newSpaceSlug = ref("");
const brandColor = ref("#42516d");
const logoSvg = ref("");
const formError = ref("");

const handleNameInput = () => {
  newSpaceSlug.value = slugify(newSpaceName.value);
};

const handleClose = () => {
  formError.value = "";
  emit("update:show", false);
};

const isValidSlug = (slug: string) => {
  return /^[a-z0-9-]+$/.test(slug);
};

const isValidHexColor = (color: string) => {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
};

async function handleLogoUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const validTypes = ["image/svg+xml", "image/png", "image/jpeg"];
  if (!validTypes.includes(file.type)) {
    formError.value = "Only SVG, PNG, and JPG files are supported";
    return;
  }

  // Logos are stored inline in space preferences, which every space request
  // carries, so keep them compact.
  if (file.size > 300 * 1024) {
    formError.value = "Logo file must be smaller than 300 KB";
    return;
  }

  try {
    if (file.type === "image/svg+xml") {
      let text = await file.text();
      text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
      text = text.replace(/on\w+="[^"]*"/g, "");
      text = text.replace(/on\w+='[^']*'/g, "");
      logoSvg.value = text;
    } else {
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        logoSvg.value = loadEvent.target?.result as string;
      };
      reader.onerror = () => {
        formError.value = "Failed to read image file";
      };
      reader.readAsDataURL(file);
    }
    formError.value = "";
  } catch {
    formError.value = "Failed to read image file";
  }
}

const handleSubmit = () => {
  if (!newSpaceName.value.trim()) {
    formError.value = "Please enter a space name";
    return;
  }

  if (!newSpaceSlug.value.trim()) {
    formError.value = "Please enter a slug";
    return;
  }

  if (!isValidSlug(newSpaceSlug.value)) {
    formError.value = "Slug must contain only lowercase letters, numbers, and hyphens";
    return;
  }

  if (!isValidHexColor(brandColor.value)) {
    formError.value = "Please enter a valid hex color (e.g., #42516d)";
    return;
  }

  formError.value = "";
  emit("create", {
    name: newSpaceName.value.trim(),
    slug: newSpaceSlug.value.trim(),
    brandColor: brandColor.value,
    logoSvg: logoSvg.value,
  });
  newSpaceName.value = "";
  newSpaceSlug.value = "";
  brandColor.value = "#42516d";
  logoSvg.value = "";
  handleClose();
};

watch(
  () => props.show,
  (newShow) => {
    if (!newShow) {
      newSpaceName.value = "";
      newSpaceSlug.value = "";
      brandColor.value = "#42516d";
      logoSvg.value = "";
      formError.value = "";
    }
  },
);
</script>

<template>
  <Dialog :show="show" title="New space" @update:show="(v) => { if (!v) handleClose() }">
    <form id="create-space-form" @submit.prevent="handleSubmit" class="space-y-4">
      <SpaceProfileCard
        :name="newSpaceName"
        :slug="newSpaceSlug"
        :brand-color="brandColor"
        :logo="logoSvg"
        @update:brand-color="brandColor = $event"
        @logo-upload="handleLogoUpload"
        @remove-logo="logoSvg = ''"
      />

      <div>
        <label
          for="space-name"
          class="block text-size-small font-medium text-neutral-900 mb-1"
        >
          Space Name
        </label>
        <input
          id="space-name"
          v-model="newSpaceName"
          type="text"
          required
          class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-md focus-ring"
          placeholder="My Space"
          @input="handleNameInput"
        >
      </div>

      <div>
        <label
          for="space-slug"
          class="block text-size-small font-medium text-neutral-900 mb-1"
        >
          Slug
        </label>
        <input
          id="space-slug"
          v-model="newSpaceSlug"
          type="text"
          required
          pattern="[a-z0-9-]+"
          class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-md focus-ring"
          placeholder="my-wiki"
        >
        <p class="mt-1 text-size-small text-neutral">
          Only lowercase letters, numbers, and hyphens
        </p>
      </div>

      <div v-if="formError" class="p-3 bg-red-50 border border-red-200 rounded-md">
        <p class="text-size-small text-red-600">{{ formError }}</p>
      </div>
    </form>

    <template #footer>
      <DialogFooter
        form="create-space-form"
        confirm-label="Create"
        @cancel="handleClose"
      />
    </template>
  </Dialog>
</template>
