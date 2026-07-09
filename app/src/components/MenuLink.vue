<script setup lang="ts">
import { twMerge } from "tailwind-merge";

const props = defineProps<{
  icon?: string;
  text?: string;
  isActive?: boolean;
  href?: string;
  badge?: number;
}>();
</script>

<template>
  <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
  <a
    :href="props.href"
    :class="twMerge(
      'button-with-icon inline-flex items-center px-[0.8rem] rounded-md font-normal text-neutral-800 transition-colors hover:transition-none cursor-pointer',
      '@max-xs:justify-center',
      isActive ? 'bg-primary-100 text-primary-700' : 'hover:bg-primary-50 active:bg-primary-100',
      'min-h-[36px]',
      'overflow-hidden whitespace-nowrap',
    )"
  >
    <div class="flex-1 flex items-center @max-xs:justify-center text-size-medium">
        <div v-html="icon" class="icon inline flex-none" />
        <span class="@max-xs:hidden">{{ text }}</span>
    </div>

    <slot />

    <span
      v-if="badge !== undefined && badge > 0"
      class="ml-auto bg-primary-100 text-neutral-800 px-1.5 py-0.5 rounded-sm text-size-small font-medium"
    >
      {{ badge }}
    </span>
  </a>
</template>
