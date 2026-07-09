<template>
  <header id="app-header" class="md:hidden sticky top-0 z-10 bg-background px-2xs py-4xs">
    <div class="flex items-center justify-between h-12">
      <ButtonGhost
        @click="handleMenuClick"
        class="flex items-center justify-center w-9 h-9 rounded-lg transition-colors text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
      >
        <div class="svg-icon h-5 w-5" v-html="menuIcon" />
        <span class="sr-only">Menu</span>
      </ButtonGhost>

      <span
        v-if="spaceName"
        class="text-size-medium font-semibold text-neutral-800 truncate max-w-[140px]"
      >
        {{ spaceName }}
      </span>

      <ButtonGhost
        @click="handleSearchClick"
        class="flex items-center justify-center w-9 h-9 rounded-lg transition-colors"
        :class="isSearchActive ? 'text-primary-600 bg-primary-50' : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100'"
      >
        <div class="svg-icon h-5 w-5" v-html="searchMagnifierIcon" />
        <span class="sr-only">Search</span>
      </ButtonGhost>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSpace } from "#composeables/useSpace.ts";
import { Actions } from "#utils/actions.ts";
import { spacePath } from "#utils/utils.ts";
import { menuIcon, searchMagnifierIcon } from "~/src/assets/icons.ts";
import ButtonGhost from "./ButtonGhost.vue";

const props = withDefaults(
  defineProps<{
    spaceName?: string;
    pathname?: string;
  }>(),
  {
    spaceName: "",
    pathname: "",
  },
);

const { currentSpace } = useSpace();

const isSearchActive = computed(() => {
  return props.pathname?.includes("/search") || false;
});

const handleMenuClick = () => {
  Actions.run("sidebar:toggle-mobile");
};

const handleSearchClick = () => {
  window.location.href = spacePath(currentSpace.value?.slug, "/search");
};
</script>
