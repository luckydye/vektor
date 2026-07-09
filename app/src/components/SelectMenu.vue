<script setup lang="ts">
import SelectItem from "./SelectItem.vue";
export interface SelectMenuItem {
  id: string;
  label: string;
  icon?: string;
}

interface Props {
  items?: SelectMenuItem[];
  modelValue?: string | string[] | null;
}

const props = withDefaults(defineProps<Props>(), {
  items: () => [],
  modelValue: null,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  select: [item: SelectMenuItem];
}>();

const handleItemClick = (item: SelectMenuItem) => {
  emit("update:modelValue", item.id);
  emit("select", item);
};
</script>

<template>
  <div
    class="flex flex-col gap-[4px] py-[4px] w-full min-w-[180px] max-h-[400px] overflow-y-auto"
  >
    <SelectItem
      v-for="item in items"
      :key="item.id"
      :icon="item.icon"
      :label="item.label"
      :selected="Array.isArray(modelValue) ? modelValue.includes(item.id) : item.id === modelValue"
      @click="handleItemClick(item)"
    />
  </div>
</template>
