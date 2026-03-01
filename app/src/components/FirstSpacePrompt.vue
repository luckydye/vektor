<template>
  <div
    v-if="showPrompt"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
  >
    <div class="bg-background rounded-lg shadow-2xl p-8 w-full max-w-lg mx-4">
      <div class="text-center mb-6">
        <div class="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
          <svg class="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </div>
        <h2 class="text-2xl font-bold text-neutral-900 mb-2">Welcome to Your Wiki!</h2>
        <p class="text-neutral">
          G'day! Let's get you sorted by creating your first space. Spaces help organize your documents and knowledge.
        </p>
      </div>

      <form @submit.prevent="handleCreateSpace" class="space-y-4">
        <div>
          <label for="space-name" class="block text-sm font-medium text-neutral-900 mb-1">
            Space Name
          </label>
          <input
            id="space-name"
            v-model="spaceName"
            type="text"
            required
            placeholder="Engineering, Product, Company Wiki..."
            class="w-full px-4 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            :disabled="isCreating"
          />
        </div>

        <div>
          <label for="space-slug" class="block text-sm font-medium text-neutral-900 mb-1">
            Slug
          </label>
          <input
            id="space-slug"
            v-model="spaceSlug"
            type="text"
            required
            placeholder="engineering"
            pattern="[a-z0-9-]+"
            class="w-full px-4 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            :disabled="isCreating"
          />
          <p class="mt-1 text-xs text-neutral">
            Only lowercase letters, numbers, and hyphens
          </p>
        </div>

        <div>
          <label for="brand-color" class="block text-sm font-medium text-neutral-900 mb-1">
            Brand Color
          </label>
          <div class="flex gap-2 items-center">
            <input
              id="brand-color"
              v-model="brandColor"
              type="color"
              class="h-10 w-20 border border-neutral-100 rounded-md cursor-pointer"
            />
            <input
              v-model="brandColor"
              type="text"
              placeholder="#1e293b"
              pattern="^#[0-9A-Fa-f]{6}$"
              class="flex-1 px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <p class="mt-1 text-xs text-neutral">
            Used for the header and sidebar
          </p>
        </div>

        <div>
          <label for="logo-svg" class="block text-sm font-medium text-neutral-900 mb-1">
            Logo (SVG)
          </label>
          <div class="space-y-2">
            <input
              id="logo-svg"
              type="file"
              accept=".svg,image/svg+xml"
              @change="handleLogoUpload"
              :disabled="isCreating"
              class="w-full px-4 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <div v-if="logoSvg" class="flex items-center gap-2 p-2 bg-neutral-300 border border-neutral-100 rounded-md">
              <div v-html="logoSvg" class="h-8 flex items-center"></div>
              <button
                type="button"
                @click="logoSvg = ''"
                :disabled="isCreating"
                class="ml-auto text-xs text-red-600 hover:text-red-800"
              >
                Remove
              </button>
            </div>
          </div>
          <p class="mt-1 text-xs text-neutral">
            Upload an SVG file for your space logo
          </p>
        </div>

        <div v-if="error" class="p-3 bg-red-50 border border-red-200 rounded-md">
          <p class="text-sm text-red-600">{{ error }}</p>
        </div>

        <button
          type="submit"
          :disabled="isCreating"
          class="w-full px-4 py-3 text-base font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {{ isCreating ? 'Creating Space...' : 'Create Your First Space' }}
        </button>
      </form>

      <div class="mt-6 pt-4 border-t border-neutral">
        <p class="text-xs text-neutral-900 text-center">
          You can create more spaces later from the space selector
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from "vue";
import { slugify } from "../utils/utils.ts";

const showPrompt = ref(false);
const spaceName = ref("");
const spaceSlug = ref("");
const brandColor = ref("#1e293b");
const logoSvg = ref("");
const isCreating = ref(false);
const error = ref(null);

watch(spaceName, (name) => {
  spaceSlug.value = slugify(name);
});

async function handleLogoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  if (!file.type.includes("svg")) {
    error.value = "Only SVG files are supported";
    return;
  }

  try {
    let text = await file.text();

    // Basic sanitization: remove script tags and event handlers
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
    text = text.replace(/on\w+="[^"]*"/g, "");
    text = text.replace(/on\w+='[^']*'/g, "");

    logoSvg.value = text;
    error.value = null;
  } catch (err) {
    error.value = "Failed to read SVG file";
    console.error("Failed to read SVG file:", err);
  }
}

async function checkForSpaces() {
  try {
    const response = await fetch("/api/v1/spaces");
    if (!response.ok) {
      throw new Error("Failed to fetch spaces");
    }

    const spaces = await response.json();
    showPrompt.value = spaces.length === 0;
  } catch (err) {
    console.error("Failed to check spaces:", err);
  }
}

async function handleCreateSpace() {
  if (!spaceName.value.trim() || !spaceSlug.value.trim()) {
    return;
  }

  isCreating.value = true;
  error.value = null;

  try {
    const response = await fetch("/api/v1/spaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: spaceName.value.trim(),
        slug: spaceSlug.value.trim(),
        preferences: {
          brandColor: brandColor.value,
          logoSvg: logoSvg.value,
        },
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to create space");
    }

    const data = await response.json();
    const newSpace = data.space;
    showPrompt.value = false;
    window.location.href = `/${newSpace.slug}`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unknown error occurred";
    console.error("Failed to create space:", err);
  } finally {
    isCreating.value = false;
  }
}

onMounted(() => {
  checkForSpaces();
});
</script>
