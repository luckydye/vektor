<script setup lang="ts">
defineProps<{
  page: number;
  totalPages: number;
  hasPrevPage: boolean;
  hasNextPage: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  previous: [];
  next: [];
}>();
</script>

<template>
  <div
    v-if="totalPages > 1"
    class="flex items-center justify-between border-t border-neutral-100"
  >
    <button
      type="button"
      :disabled="disabled || !hasPrevPage"
      class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      @click="emit('previous')"
    >
      Previous
    </button>
    <span class="text-size-small text-neutral-400">{{ page }} / {{ totalPages }}</span>
    <button
      type="button"
      :disabled="disabled || !hasNextPage"
      class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      @click="emit('next')"
    >
      Next
    </button>
  </div>
</template>
