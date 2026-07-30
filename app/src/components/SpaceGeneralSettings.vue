<script setup lang="ts">
import { ref, watch } from "vue";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  isWorkflowCreationEnabled,
  spacePreferenceKeys,
} from "#utils/spacePreferences.ts";
import Button from "./Button.vue";
import Dialog from "./Dialog.vue";
import DialogFooter from "./DialogFooter.vue";
import SpaceMembers from "./SpaceMembers.vue";
import SpaceProfileCard from "./SpaceProfileCard.vue";
import SwitchToggle from "./SwitchToggle.vue";

const { currentSpace, updateSpace } = useSpace();
const toast = useToast();

const VEKTOR_VERSION = import.meta.env.VEKTOR_VERSION;

const localName = ref("");
const localDescription = ref("");
const localBrandColor = ref("#1e293b");
const localLogoSvg = ref("");
const localWorkflowCreationEnabled = ref(true);
const isSaving = ref(false);
const isSavingWorkflowCreationEnabled = ref(false);
const error = ref<string | null>(null);

async function saveWorkflowCreationEnabled(enabled: boolean) {
  if (!currentSpace.value || isSavingWorkflowCreationEnabled.value) return;

  const previousValue = localWorkflowCreationEnabled.value;
  localWorkflowCreationEnabled.value = enabled;
  isSavingWorkflowCreationEnabled.value = true;
  error.value = null;

  try {
    await api.space.patch(currentSpace.value.id, {
      preferences: {
        [spacePreferenceKeys.workflowCreationEnabled]: String(enabled),
      },
    });
    toast.success("Feature settings saved");
  } catch (err) {
    localWorkflowCreationEnabled.value = previousValue;
    error.value =
      err instanceof Error ? err.message : "Failed to update feature settings";
  } finally {
    isSavingWorkflowCreationEnabled.value = false;
  }
}

async function handleLogoUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const validTypes = ["image/svg+xml", "image/png", "image/jpeg"];
  if (!validTypes.includes(file.type)) {
    error.value = "Only SVG, PNG, and JPG files are supported";
    return;
  }

  // The logo is stored inline in the space preferences, which every space
  // request carries — keep it small.
  if (file.size > 300 * 1024) {
    error.value = "Logo file must be smaller than 300 KB";
    return;
  }

  try {
    if (file.type === "image/svg+xml") {
      let text = await file.text();
      text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
      text = text.replace(/on\w+="[^"]*"/g, "");
      text = text.replace(/on\w+='[^']*'/g, "");
      localLogoSvg.value = text;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        localLogoSvg.value = e.target?.result as string;
      };
      reader.onerror = () => {
        error.value = "Failed to read image file";
      };
      reader.readAsDataURL(file);
    }
    error.value = null;
  } catch {
    error.value = "Failed to read image file";
  }
}

async function handleSave() {
  if (!currentSpace.value) return;

  isSaving.value = true;
  error.value = null;

  try {
    await updateSpace(
      currentSpace.value.id,
      localName.value.trim(),
      currentSpace.value.slug,
      {
        description: localDescription.value.trim(),
        brandColor: localBrandColor.value,
        logoSvg: localLogoSvg.value,
        [spacePreferenceKeys.workflowCreationEnabled]: String(
          localWorkflowCreationEnabled.value,
        ),
      },
    );
    toast.success("Space settings saved");
    emit("saved");
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to update space";
  } finally {
    isSaving.value = false;
  }
}

const showDeleteConfirm = ref(false);
const deleteConfirmText = ref("");
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

function closeDeleteConfirm() {
  showDeleteConfirm.value = false;
  deleteConfirmText.value = "";
  deleteError.value = null;
}

async function handleDeleteSpace() {
  if (!currentSpace.value?.id || deleteConfirmText.value !== currentSpace.value.slug)
    return;
  deleteError.value = null;
  isDeleting.value = true;

  try {
    await api.space.delete(currentSpace.value.id);
    window.location.href = "/";
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : "Failed to delete space";
    isDeleting.value = false;
  }
}

watch(
  () => currentSpace.value,
  () => {
    if (currentSpace.value) {
      if (!isSavingWorkflowCreationEnabled.value) {
        localName.value = currentSpace.value.name;
        localDescription.value = currentSpace.value.preferences?.description || "";
        localBrandColor.value = currentSpace.value.preferences?.brandColor || "#1e293b";
        localLogoSvg.value = currentSpace.value.preferences?.logoSvg || "";
        localWorkflowCreationEnabled.value = isWorkflowCreationEnabled(
          currentSpace.value.preferences,
        );
      }
      error.value = null;
    }
  },
  {
    immediate: true,
  },
);
</script>

<template>
  <div>
    <!-- Profile: preview + form -->
    <div class="flex flex-col sm:flex-row gap-8 sm:gap-10 items-start">
      <!-- Interactive preview card — sticky -->
      <div class="w-full sm:w-72 shrink-0 sm:sticky top-4">
        <SpaceProfileCard
          :name="localName"
          :slug="currentSpace?.slug ?? ''"
          :description="localDescription"
          :brand-color="localBrandColor"
          :logo="localLogoSvg"
          @update:brand-color="localBrandColor = $event"
          @logo-upload="handleLogoUpload"
          @remove-logo="localLogoSvg = ''"
        />
      </div>

      <!-- Form -->
      <form class="flex-1 min-w-0 w-full" @submit.prevent="handleSave">
        <div class="space-y-4">
          <div>
            <label
              for="settings-space-name"
              class="block text-size-small font-medium text-neutral-700 mb-1"
              >Name</label
            >
            <input
              id="settings-space-name"
              v-model="localName"
              type="text"
              required
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus-ring"
            >
          </div>
          <div>
            <label
              for="settings-space-description"
              class="block text-size-small font-medium text-neutral-700 mb-1"
              >Description</label
            >
            <input
              id="settings-space-description"
              v-model="localDescription"
              type="text"
              placeholder="e.g., Engineering / Documentation"
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus-ring"
            >
          </div>
        </div>
        <div
          v-if="error"
          class="mt-4 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600"
        >
          {{ error }}
        </div>
        <div class="mt-6 flex justify-end">
          <Button
            type="submit"
            :disabled="isSaving"
            :text="isSaving ? 'Saving…' : 'Save Changes'"
          />
        </div>
      </form>
    </div>

    <!-- Features -->
    <section class="mt-10">
      <h2 class="text-size-large font-semibold text-neutral-900">Features</h2>
      <div class="mt-3 flex items-center justify-between gap-4">
        <div>
          <p class="text-size-medium font-medium text-neutral-900">Workflows</p>
          <p class="text-size-small text-neutral-500 mt-0.5">
            Allow members to create workflow documents in this space.
          </p>
        </div>
        <SwitchToggle
          :model-value="localWorkflowCreationEnabled"
          :disabled="isSavingWorkflowCreationEnabled"
          @update:model-value="saveWorkflowCreationEnabled"
        />
      </div>
    </section>

    <!-- Members -->
    <div class="mt-10">
      <SpaceMembers />
    </div>

    <!-- Danger Zone -->
    <div class="mt-10 pt-6">
      <h2 class="text-size-medium font-semibold text-red-700 mb-3">Danger Zone</h2>
      <div
        class="border border-primary-200 rounded-lg p-4 flex items-center justify-between gap-4"
      >
        <div>
          <p class="text-size-medium font-medium text-neutral-900">Delete this space</p>
          <p class="text-size-small text-neutral-500 mt-0.5">
            All documents and data will be archived. This cannot be undone.
          </p>
        </div>
        <Button tone="danger" text="Delete Space" @click="showDeleteConfirm = true" />
      </div>
    </div>

    <div class="mt-12 opacity-20 text-right">
      <span>Vektor v{{ VEKTOR_VERSION }}</span>
    </div>
  </div>

  <Dialog
    :show="showDeleteConfirm"
    title="Delete Space"
    :close-on-backdrop="!isDeleting"
    @update:show="(v) => { if (!v) closeDeleteConfirm() }"
  >
    <p class="text-size-medium text-neutral-600 mb-3">
      Are you sure you want to delete <strong>{{ currentSpace?.name }}</strong>? This
      action will archive all documents and data.
    </p>
    <p class="text-size-medium text-neutral-600 mb-3">
      Type
      <code class="px-1.5 py-0.5 bg-neutral-100 rounded-sm font-mono text-size-medium"
        >{{ currentSpace?.slug }}</code
      >
      to confirm:
    </p>
    <input
      v-model="deleteConfirmText"
      type="text"
      placeholder="Type space slug"
      class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 mb-3"
    >
    <div
      v-if="deleteError"
      class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600"
    >
      {{ deleteError }}
    </div>

    <template #footer>
      <DialogFooter
        tone="danger"
        confirm-label="Delete Space"
        pending-label="Deleting..."
        :pending="isDeleting"
        :disabled="deleteConfirmText !== currentSpace?.slug"
        @cancel="closeDeleteConfirm"
        @confirm="handleDeleteSpace"
      />
    </template>
  </Dialog>
</template>
