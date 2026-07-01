<script setup lang="ts">
import { computed } from "vue";
import { useSpace } from "../composeables/useSpace.ts";
import { spacePath } from "../utils/utils.ts";

interface BreadcrumbItem {
  id: string;
  slug: string;
  title: string;
}

interface Category {
  id: string;
  name: string;
  slug: string;
  color?: string;
  icon?: string;
}

interface Props {
  category?: Category | null;
  parents?: BreadcrumbItem[];
  currentTitle: string;
}

const props = withDefaults(defineProps<Props>(), {
  parents: () => [],
  category: null,
});

const { currentSpace } = useSpace();

const showBreadcrumbs = computed(() => props.category || props.parents.length > 0);
</script>

<template>
  <nav v-if="showBreadcrumbs" aria-label="Breadcrumb" class="breadcrumbs text-size-medium text-neutral-600">
    <ol class="flex items-center gap-1 flex-wrap">
      <!-- Category -->
      <li v-if="category" class="flex items-center gap-1.5">
        <a
          :href="spacePath(currentSpace?.slug, `/?category=${category.slug}`)"
          class="inline-flex items-center gap-1.5 hover:text-neutral-900 hover:underline transition-colors"
        >
          <span v-if="category.icon" class="text-base">{{ category.icon }}</span>
          <span>{{ category.name }}</span>
        </a>
        <span class="text-neutral-400 px-1" aria-hidden="true">&rsaquo;</span>
      </li>

      <!-- Parent Documents -->
      <li v-for="parent in parents" :key="parent.id" class="flex items-center gap-1.5">
        <a
          :href="spacePath(currentSpace?.slug, `/doc/${parent.slug}`)"
          class="hover:text-neutral-900 hover:underline transition-colors truncate max-w-[200px] px-1"
          :title="parent.title"
        >
          {{ parent.title }}
        </a>
        <span class="text-neutral-400 px-1" aria-hidden="true">&rsaquo;</span>
      </li>

      <!-- Current Document -->
      <li class="px-1">
        <span class="text-neutral-900 font-medium truncate max-w-[200px] block" :title="currentTitle">
          {{ currentTitle }}
        </span>
      </li>
    </ol>
  </nav>
</template>
