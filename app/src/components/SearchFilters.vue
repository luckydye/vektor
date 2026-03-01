<script setup lang="ts">
import { ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api, type PropertyFilter } from "../api/client.ts";

const props = defineProps<{
  spaceId: string;
  modelValue: PropertyFilter[];
}>();

const emit = defineEmits<{
  "update:modelValue": [filters: PropertyFilter[]];
  search: [];
}>();

const selectedPropertyKey = ref<string | null>(null);

// Fetch available properties for the space (excluding "title" which is searched via main input)
const { data: availableProperties } = useQuery({
  queryKey: ["properties", props.spaceId],
  queryFn: async () => {
    const properties = await api.properties.get(props.spaceId);
    return properties.filter((p) => p.name !== "title");
  },
});

const selectedProperty = () => {
  if (!selectedPropertyKey.value || !availableProperties.value) return null;
  return (
    availableProperties.value.find((p) => p.name === selectedPropertyKey.value) || null
  );
};

const addFilter = (key: string, value: string | null) => {
  const filter: PropertyFilter = { key, value };

  // Check for duplicates
  const exists = props.modelValue.some(
    (f) => f.key === filter.key && f.value === filter.value,
  );

  if (!exists) {
    emit("update:modelValue", [...props.modelValue, filter]);
    selectedPropertyKey.value = null;
    emit("search");
  }
};

const removeFilter = (index: number) => {
  const newFilters = [...props.modelValue];
  newFilters.splice(index, 1);
  emit("update:modelValue", newFilters);
  emit("search");
};

const selectPropertyKey = (key: string) => {
  if (selectedPropertyKey.value === key) {
    selectedPropertyKey.value = null;
  } else {
    selectedPropertyKey.value = key;
  }
};

const selectPropertyValue = (value: string) => {
  if (!selectedPropertyKey.value) return;
  addFilter(selectedPropertyKey.value, value);
};

const addHasPropertyFilter = () => {
  if (!selectedPropertyKey.value) return;
  addFilter(selectedPropertyKey.value, null);
};
</script>

<template>
  <div>
    <!-- Active Filters -->
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-2 mb-4">
      <div
        v-for="(filter, index) in modelValue"
        :key="index"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-100 text-blue-800 rounded-full text-sm"
      >
        <span class="font-medium">{{ filter.key }}</span>
        <span v-if="filter.value !== null" class="text-blue-600">=</span>
        <span v-if="filter.value !== null" class="text-blue-700">"{{ filter.value }}"</span>
        <span v-else class="text-blue-600 italic">exists</span>
        <button
          @click="removeFilter(index)"
          class="ml-1 p-0.5 hover:bg-blue-200 rounded-full"
          title="Remove filter"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    </div>

    <!-- Property Selection -->
    <div v-if="availableProperties && availableProperties.length > 0">
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="prop in availableProperties"
          :key="prop.name"
          @click="selectPropertyKey(prop.name)"
          class="px-3 py-1.5 text-sm rounded-lg border transition-colors"
          :class="selectedPropertyKey === prop.name ? 'bg-blue-500 border-blue-500 text-white' : 'bg-background border-neutral-100 text-neutral-700 hover:border-neutral-400'"
        >
          {{ prop.name }}
        </button>
      </div>

      <!-- Value Selection (shown when property is selected) -->
      <div v-if="selectedPropertyKey && selectedProperty()" class="mt-3 pt-3 border-t border-neutral-100">
        <div class="flex flex-wrap gap-1.5 items-center">
          <span class="text-sm text-neutral-500 mr-1">{{ selectedPropertyKey }} =</span>
          <button
            v-for="val in selectedProperty()!.values.slice(0, 20)"
            :key="val"
            @click="selectPropertyValue(val)"
            class="px-2.5 py-1 text-sm rounded border bg-background border-neutral-100 text-neutral-700 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            {{ val }}
          </button>
          <span v-if="selectedProperty()!.values.length > 20" class="text-sm text-neutral-400">
            +{{ selectedProperty()!.values.length - 20 }} more
          </span>
          <button
            @click="addHasPropertyFilter"
            class="px-2.5 py-1 text-sm rounded border border-dashed border-neutral-100 text-neutral-500 hover:border-blue-400 hover:text-blue-600 transition-colors italic"
          >
            any value
          </button>
        </div>
      </div>
    </div>

    <div v-else class="text-sm text-neutral-500">
      No properties available for filtering
    </div>
  </div>
</template>