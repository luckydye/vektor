<script setup lang="ts">
defineProps<{
  hasPrevPage: boolean;
  hasNextPage: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  prev: [];
  next: [];
}>();
</script>

<template>
  <div
    v-if="hasPrevPage || hasNextPage"
    class="flex items-center justify-between border-t border-neutral-100"
  >
    <button
      type="button"
      :disabled="disabled || !hasPrevPage"
      class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      @click="emit('prev')"
    >
      Previous
    </button>
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
