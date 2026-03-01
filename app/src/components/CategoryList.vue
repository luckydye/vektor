<template>
  <div class="category-list">
    <div v-if="isLoading" class="text-center py-8">
      <p>Loading categories...</p>
    </div>

    <div v-else-if="error" class="text-center py-8">
      <p class="text-red-600">Failed to load categories</p>
    </div>

    <div v-else-if="categories.length === 0" class="text-center py-12 bg-neutral-300 rounded-lg border border-neutral">
      <svg class="mx-auto h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
      </svg>
      <h3 class="mt-2 text-sm font-medium">No categories yet</h3>
      <p class="mt-1 text-sm">
        Create categories to organize your documents.
      </p>
    </div>

    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <a
        v-for="category in sortedCategories"
        :key="category.id"
        :href="getCategoryUrl(category.slug)"
        class="block p-6 bg-background rounded-lg border-2 border-neutral-100 hover:border-blue-500 hover:shadow-md transition-all"
      >
        <div class="flex items-start gap-4">
          <div
            class="w-12 h-12 rounded-lg flex items-center justify-center text-xl font-semibold flex-shrink-0"
            :style="{
              backgroundColor: category.color || '#E5E7EB',
              color: getTextColor(category.color)
            }"
          >
            {{ category.icon || category.name.charAt(0).toUpperCase() }}
          </div>

          <div class="flex-1 min-w-0">
            <h3 class="text-lg font-semibold mb-1">
              {{ category.name }}
            </h3>
            <p v-if="category.description" class="text-sm">
              {{ category.description }}
            </p>
            <div class="mt-3 flex items-center gap-2">
              <span class="text-xs ">
                {{ getDocumentCount(category.slug) }} documents
              </span>
            </div>
          </div>
        </div>
      </a>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { useCategories } from "../composeables/useCategories.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { getTextColor } from "../utils/utils.ts";

const props = defineProps({
  documents: {
    type: Array,
    default: () => [],
  },
});

const { currentSpaceId, currentSpace } = useSpace();
const { categories, loadCategories, isLoading, error } = useCategories();

const sortedCategories = computed(() => {
  return [...categories.value].sort((a, b) => a.order - b.order);
});

const documentCounts = computed(() => {
  const counts = {};

  for (const doc of props.documents) {
    const category = doc.properties.category || doc.properties.collection;
    if (category) {
      counts[category] = (counts[category] || 0) + 1;
    }
  }

  return counts;
});

function getDocumentCount(categorySlug) {
  return documentCounts.value[categorySlug] || 0;
}

function getCategoryUrl(categorySlug) {
  if (currentSpace.value) {
    return `/${currentSpace.value.slug}/category/${categorySlug}`;
  }
  return `/category/${categorySlug}`;
}

onMounted(async () => {
  if (currentSpaceId.value) {
    await loadCategories(currentSpaceId.value);
  }
});
</script>
