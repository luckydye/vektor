<template>
  <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
  <label
    class="inline-flex items-center gap-2"
    :class="disabled ? 'cursor-not-allowed' : 'cursor-pointer'"
  >
    <input
      type="checkbox"
      class="sr-only peer"
      :checked="modelValue"
      :disabled="disabled"
      role="switch"
      :aria-checked="modelValue"
      @change="handleChange"
    >
    <span
      class="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-neutral-200 transition-colors peer-checked:bg-green-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-500 peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4"
    ></span>
    <span v-if="label" class="text-size-small text-neutral-700">
      {{ label }}
    </span>
  </label>
</template>

<script setup lang="ts">
import { play } from 'cuelume';

defineProps<{
  modelValue: boolean;
  disabled?: boolean;
  label?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

function handleChange(event: Event) {
  play("toggle");
  emit("update:modelValue", (event.target as HTMLInputElement).checked);
}
</script>
