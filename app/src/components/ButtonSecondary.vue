<script setup lang="ts">
const props = defineProps<{
  text?: string;
  icon?: string;
  ariaLabel?: string;
}>();
</script>

<template>
  <button
    class="button-secondary"
    :aria-label="props.ariaLabel ?? props.text"
    :title="props.ariaLabel ?? props.text"
  >
    <slot/>
    <div v-html="props.icon" class="text-primary-600" />
    <span v-if="props.text">{{ props.text }}</span>
  </button>
</template>
