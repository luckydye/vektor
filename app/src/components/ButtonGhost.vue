<script setup lang="ts">
const props = defineProps<{
  text?: string;
  icon?: string;
}>();

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const handleClick = (event: MouseEvent) => {
  emit("click", event);
};
</script>

<template>
  <button type="button"
    class="button-ghost"
    @click="handleClick"
  >
    <slot />
    <div v-if="icon" v-html="icon" />
    <span v-if="text">{{ text }}</span>
  </button>
</template>
