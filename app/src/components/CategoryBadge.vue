<template>
  <div
    v-if="category"
    class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium"
    :style="{
      backgroundColor: category.color || '#E5E7EB',
      color: textColor
    }"
  >
    <span v-if="category.icon" class="text-sm">{{ category.icon }}</span>
    <span>{{ category.name }}</span>
  </div>
  <div
    v-else-if="showEmpty"
    class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium neutral text-neutral"
  >
    <span>Uncategorized</span>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { getTextColor } from "../utils/utils.ts";

const props = defineProps({
  category: {
    type: Object,
    default: null,
  },
  showEmpty: {
    type: Boolean,
    default: false,
  },
});

const textColor = computed(() => {
  return getTextColor(props.category?.color);
});
</script>
