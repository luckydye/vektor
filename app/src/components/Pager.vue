<script setup lang="ts">
import "@sv/elements/pager";

const props = defineProps<{
  page: number;
  totalPages: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  change: [page: number];
}>();

function onPagerChange(e: Event) {
  e.preventDefault();
  if (props.disabled) {
    return;
  }
  emit("change", (e as CustomEvent<{ page: number }>).detail.page);
}
</script>

<template>
  <a-pager
    v-if="totalPages > 1"
    :page="page"
    :count="totalPages"
    class="flex items-center justify-between border-t border-neutral-100"
    @change="onPagerChange"
  >
    <button
      slot="prev"
      type="button"
      :disabled="disabled || page <= 1"
      class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      Previous
    </button>
    <button
      slot="next"
      type="button"
      :disabled="disabled || page >= totalPages"
      class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      Next
    </button>
  </a-pager>
</template>

<style>
a-pager::part(pages) {
  display: flex;
  align-items: center;
  gap: 0.125rem;
}

a-pager::part(page) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.75rem;
  height: 1.75rem;
  padding: 0 0.375rem;
  font-size: var(--text-size-small);
  font-weight: 500;
  border-radius: 0.375rem;
  color: var(--color-neutral-500);
  transition: background-color 0.15s, color 0.15s;
}

a-pager::part(page):hover {
  background-color: var(--color-neutral-50);
  color: var(--color-neutral-700);
}

a-pager::part(page active) {
  background-color: var(--color-primary-50);
  color: var(--color-primary-700);
}

a-pager::part(ellipsis) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.75rem;
  height: 1.75rem;
  font-size: var(--text-size-small);
  color: var(--color-neutral-400);
}
</style>
