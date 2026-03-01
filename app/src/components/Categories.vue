<script setup lang="ts">
import { ref, onMounted } from "vue";
import { getTextColor } from "../utils/utils.ts";
import { api, type Category } from "../api/client.ts";

const props = defineProps<{
  spaceSlug: string;
  spaceId: string;
}>();

const categories = ref<Category[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const categoryFirstDocSlug = ref<Record<string, string | null>>({});

onMounted(async () => {
  try {
    const fetchedCategories = await api.categories.get(props.spaceId);
    categories.value = fetchedCategories;

    const firstDocs = await Promise.all(
      fetchedCategories.map(async (cat) => {
        const response = await api.documents.get(props.spaceId, {
          categorySlugs: cat.slug,
        });
        const docs = response.documents;
        const mostRecent = docs.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0];
        return [cat.slug, mostRecent?.slug ?? null] as const;
      }),
    );
    categoryFirstDocSlug.value = Object.fromEntries(firstDocs);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load categories";
  } finally {
    loading.value = false;
  }
});

const getCategoryHref = (category: Category): string => {
  const docSlug = categoryFirstDocSlug.value[category.slug];
  if (docSlug) return `/${props.spaceSlug}/doc/${docSlug}`;
  return `/${props.spaceSlug}?category=${category.slug}`;
};
</script>

<template>
  <div class="space-y-6">
    <!-- Empty State -->
    <div
      v-if="!loading && categories.length === 0"
      class="text-center py-12 bg-neutral-50 rounded-lg border border-neutral-100"
    >
      <svg class="mx-auto h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
        />
      </svg>
      <h3 class="mt-2 text-sm font-medium">No categories yet</h3>
      <p class="mt-1 text-sm">
        Use the "Manage Categories" button in the sidebar to create your first category.
      </p>
    </div>

    <!-- Loading State - Skeletons -->
    <div v-if="loading" class="flex flex-wrap gap-4">
      <div v-for="i in 3" :key="`skeleton-${i}`" class="block p-6 bg-background rounded-lg border-2 border-neutral-100 min-w-[250px] flex-1 animate-pulse">
        <div class="flex items-start gap-4">
          <div class="w-14 h-14 rounded-lg flex-shrink-0 bg-neutral-200"></div>
          <div class="flex-1 min-w-0 space-y-2">
            <div class="h-6 bg-neutral-200 rounded w-3/4"></div>
            <div class="h-4 bg-neutral-200 rounded w-full"></div>
            <div class="h-4 bg-neutral-200 rounded w-5/6"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Error State -->
    <div v-if="error && !loading" class="text-center py-12 bg-red-50 rounded-lg border border-red-200">
      <p class="text-red-600">{{ error }}</p>
    </div>

    <!-- Categories Grid -->
    <div v-if="!loading && categories.length > 0" class="flex flex-wrap gap-4">
      <a
        v-for="category in categories"
        :key="category.id"
        :href="getCategoryHref(category)"
        class="block p-6 bg-background rounded-lg border-2 border-neutral-100 hover:border-blue-500 hover:shadow-md min-w-[250px] flex-1"
      >
        <div class="flex items-start gap-4">
          <div
            class="w-14 h-14 rounded-lg flex items-center justify-center text-2xl font-semibold flex-shrink-0"
            :style="{
              backgroundColor: category.color || '#E5E7EB',
              color: getTextColor(category.color || '#E5E7EB'),
            }"
          >
            {{ category.icon || category.name.charAt(0).toUpperCase() }}
          </div>

          <div class="flex-1 min-w-0">
            <h3 class="text-lg font-semibold mb-1">
              {{ category.name }}
            </h3>
            <p v-if="category.description" class="text-sm mb-3">
              {{ category.description }}
            </p>
          </div>
        </div>
      </a>
    </div>
  </div>
</template>
