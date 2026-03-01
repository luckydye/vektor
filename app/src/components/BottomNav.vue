<template>
  <nav class="lg:hidden fixed bottom-xs left-1/2 -translate-x-1/2 rounded-4xl px-m border border-neutral-100 z-10 bg-neutral-100">
    <div class="flex items-center justify-around gap-m">
      <a
        :href="`/${spaceSlug}`"
        class="flex flex-col items-center justify-center flex-1 px-1 py-4 rounded-lg transition-colors"
        :class="isHomeActive ? 'text-blue-600' : 'text-neutral-600 hover:text-neutral-900'"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
        <span class="sr-only text-xs mt-1">Home</span>
      </a>

      <a
        :href="`/${spaceSlug}/search`"
        class="flex flex-col items-center justify-center flex-1 px-1 py-4 rounded-lg transition-colors"
        :class="isSearchActive ? 'text-blue-600' : 'text-neutral-600 hover:text-neutral-900'"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span class="sr-only text-xs mt-1">Search</span>
      </a>

      <button
        @click="handleMenuClick"
        class="flex flex-col items-center justify-center flex-1 px-1 py-4 rounded-lg transition-colors"
        :class="'text-neutral-600 hover:text-neutral-900'"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <span class="sr-only text-xs mt-1">Menu</span>
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Actions } from "../utils/actions.ts";

const props = withDefaults(
  defineProps<{
    spaceSlug?: string;
    pathname?: string;
  }>(),
  {
    spaceSlug: "",
    pathname: "",
  },
);

const isHomeActive = computed(() => {
  if (!props.pathname) return false;
  const pathParts = props.pathname.split("/").filter(Boolean);
  return pathParts.length === 1;
});

const isSearchActive = computed(() => {
  return props.pathname?.includes("/search") || false;
});

const handleMenuClick = () => {
  Actions.run("sidebar:toggle");
};
</script>
