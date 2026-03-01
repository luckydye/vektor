<script setup lang="ts">
import "@sv/elements/list";

const props = defineProps<{
  onClick: (e: Event) => void;
}>();
</script>

<template>
  <a-list-item class="group">
    <button
      @click="(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onClick(e);
      }"
      :class="[
        'flex items-center gap-2.5 px-3xs pr-xs py-5xs w-full transition-colors hover:transition-none hover:bg-primary-50 active:bg-primary-100 rounded-md',
        'group-aria-selected:bg-primary-10'
      ]"
    >
      <slot></slot>
    </button>
  </a-list-item>
</template>
