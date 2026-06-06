<template>
  <nav class="lg:hidden fixed bottom-xs left-1/2 -translate-x-1/2 rounded-4xl px-m border border-neutral-100 z-10 bg-neutral-100">
    <div class="flex items-center justify-around gap-m">
      <a
        :href="`/${spaceSlug}`"
        class="flex flex-col items-center justify-center flex-1 px-1 py-4 rounded-lg transition-colors"
        :class="isHomeActive ? 'text-blue-600' : 'text-neutral-600 hover:text-neutral-900'"
      >
        <div class="svg-icon h-6 w-6" v-html="homeOutlineIcon" />
        <span class="sr-only text-xs mt-1">Home</span>
      </a>

      <a
        :href="`/${spaceSlug}/search`"
        class="flex flex-col items-center justify-center flex-1 px-1 py-4 rounded-lg transition-colors"
        :class="isSearchActive ? 'text-blue-600' : 'text-neutral-600 hover:text-neutral-900'"
      >
        <div class="svg-icon h-6 w-6" v-html="searchMagnifierIcon" />
        <span class="sr-only text-xs mt-1">Search</span>
      </a>

      <button
        @click="handleMenuClick"
        class="flex flex-col items-center justify-center flex-1 px-1 py-4 rounded-lg transition-colors"
        :class="'text-neutral-600 hover:text-neutral-900'"
      >
        <div class="svg-icon h-6 w-6" v-html="menuIcon" />
        <span class="sr-only text-xs mt-1">Menu</span>
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { homeOutlineIcon, menuIcon, searchMagnifierIcon } from "~/src/assets/icons.ts";
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
