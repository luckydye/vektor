<script setup lang="ts">
import { computed, ref } from "vue";
import { chevronRightThinIcon, closeXIcon } from "~/src/assets/icons.ts";
import { api, type PropertyFilter } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";

const props = defineProps<{
  spaceId: string;
  modelValue: PropertyFilter[];
}>();

const emit = defineEmits<{
  "update:modelValue": [filters: PropertyFilter[]];
  search: [];
}>();

const DATE_FILTER_KEY = "_date";

const DATE_FILTERS = [
  { label: "Today", value: "today" },
  { label: "This week", value: "week" },
  { label: "This month", value: "month" },
  { label: "Older", value: "older" },
];

const dateLabel = (value: string) =>
  DATE_FILTERS.find((d) => d.value === value)?.label ?? value;

const expandedProperties = ref<Set<string>>(new Set());

const { data: availableProperties } = useQuery({
  queryKey: ["properties", props.spaceId],
  queryFn: async () => {
    const properties = await api.properties.get(props.spaceId);
    return properties.filter((p) => p.name !== "title");
  },
});

const typeValues = computed(
  () => availableProperties.value?.find((p) => p.name === "type")?.values ?? [],
);

const nonTypeProperties = computed(
  () => availableProperties.value?.filter((p) => p.name !== "type") ?? [],
);

const TYPE_STYLES: Record<string, string> = {
  canvas: "bg-violet-100 text-violet-600",
  csv: "bg-emerald-100 text-emerald-700",
  file: "bg-neutral-100 text-neutral-500",
  document: "bg-neutral-100 text-neutral-500",
};

const activeDateFilter = computed(
  () => props.modelValue.find((f) => f.key === DATE_FILTER_KEY)?.value ?? null,
);

const hasActiveFilter = (key: string, value: string | null) =>
  props.modelValue.some((f) => f.key === key && f.value === value);

const addFilter = (key: string, value: string | null) => {
  if (hasActiveFilter(key, value)) return;
  emit("update:modelValue", [...props.modelValue, { key, value }]);
  emit("search");
};

const removeFilter = (index: number) => {
  const newFilters = [...props.modelValue];
  newFilters.splice(index, 1);
  emit("update:modelValue", newFilters);
  emit("search");
};

const removeFilterByKeyValue = (key: string, value: string | null) => {
  emit(
    "update:modelValue",
    props.modelValue.filter((f) => !(f.key === key && f.value === value)),
  );
  emit("search");
};

const toggleFilter = (key: string, value: string | null) => {
  if (hasActiveFilter(key, value)) {
    removeFilterByKeyValue(key, value);
  } else {
    addFilter(key, value);
  }
};

const setDateFilter = (value: string) => {
  const withoutDate = props.modelValue.filter((f) => f.key !== DATE_FILTER_KEY);
  if (activeDateFilter.value === value) {
    emit("update:modelValue", withoutDate);
  } else {
    emit("update:modelValue", [...withoutDate, { key: DATE_FILTER_KEY, value }]);
  }
  emit("search");
};

const toggleProperty = (name: string) => {
  if (expandedProperties.value.has(name)) {
    expandedProperties.value.delete(name);
  } else {
    expandedProperties.value.add(name);
  }
};

const clearAll = () => {
  emit("update:modelValue", []);
  emit("search");
};

const hasAnyFilters = computed(() => props.modelValue.length > 0);
</script>

<template>
  <div class="flex flex-col select-none">
    <!-- Header -->
    <div class="px-3 py-2.5 border-b border-neutral-100 flex items-center justify-between">
      <span class="text-size-small font-semibold text-neutral-700">Filters</span>
      <button
        v-if="hasAnyFilters"
        @click="clearAll"
        class="text-[11px] text-neutral hover:text-neutral-800 transition-colors"
      >
        Clear all
      </button>
    </div>

    <!-- Active Filters -->
    <div v-if="hasAnyFilters" class="px-3 py-2.5 border-b border-neutral-100">
      <div class="text-[11px] font-medium text-neutral uppercase tracking-wider mb-1.5">Active</div>
      <div class="flex flex-wrap gap-1">
        <div
          v-for="(filter, index) in modelValue"
          :key="index"
          class="flex items-center gap-1 px-2 py-0.5 bg-primary-100 text-primary-700 rounded-md text-[11px] max-w-full"
        >
          <span class="font-medium truncate">
            {{ filter.key === DATE_FILTER_KEY ? "Modified" : filter.key }}
          </span>
          <span v-if="filter.key === DATE_FILTER_KEY">: {{ dateLabel(filter.value ?? "") }}</span>
          <span v-else-if="filter.value !== null"> = {{ filter.value }}</span>
          <span v-else class="italic"> (exists)</span>
          <button @click="removeFilter(index)" class="ml-0.5 hover:text-primary-900 flex-none">
            <div class="svg-icon w-3 h-3" v-html="closeXIcon" />
          </button>
        </div>
      </div>
    </div>

    <!-- Modified -->
    <div class="px-3 pt-3 pb-1">
      <div class="text-[11px] font-medium text-neutral uppercase tracking-wider mb-1">Modified</div>
    </div>
    <div class="px-1 pb-3">
      <button
        v-for="df in DATE_FILTERS"
        :key="df.value"
        @click="setDateFilter(df.value)"
        class="w-full text-left px-3 py-1.5 rounded-md flex items-center text-size-small transition-colors hover:transition-none"
        :class="
          activeDateFilter === df.value
            ? 'bg-primary-100 text-primary-700 font-medium'
            : 'text-neutral-700 hover:bg-primary-50'
        "
      >
        {{ df.label }}
      </button>
    </div>

    <!-- Type -->
    <template v-if="typeValues.length > 0">
      <div class="px-3 pt-3 pb-1 border-t border-neutral-100">
        <div class="text-[11px] font-medium text-neutral uppercase tracking-wider mb-1">Type</div>
      </div>
      <div class="px-3 pb-3 flex flex-wrap gap-1">
        <button
          v-for="tv in typeValues"
          :key="tv"
          @click="toggleFilter('type', tv)"
          class="px-2 py-0.5 rounded-md text-[11px] font-medium capitalize border transition-colors hover:transition-none"
          :class="hasActiveFilter('type', tv)
            ? (TYPE_STYLES[tv] ?? 'bg-neutral-100 text-neutral-500') + ' border-transparent'
            : 'bg-background text-neutral-600 border-neutral-200 hover:border-neutral-300'"
        >
          {{ tv }}
        </button>
      </div>
    </template>

    <!-- Properties -->
    <template v-if="nonTypeProperties.length > 0">
      <div class="px-3 pt-2 pb-1 border-t border-neutral-100">
        <div class="text-[11px] font-medium text-neutral uppercase tracking-wider">Properties</div>
      </div>
      <div class="px-1 pb-2">
        <div v-for="prop in nonTypeProperties" :key="prop.name" class="mb-0.5">
          <button
            @click="toggleProperty(prop.name)"
            class="w-full text-left px-3 py-1.5 rounded-md flex items-center gap-2 text-size-small transition-colors hover:transition-none text-neutral-700 hover:bg-primary-50"
          >
            <div
              class="svg-icon w-3 h-3 text-neutral flex-none transition-transform duration-150"
              :class="expandedProperties.has(prop.name) ? 'rotate-90' : ''"
              v-html="chevronRightThinIcon"
            />
            <span class="flex-1 truncate">{{ prop.name }}</span>
            <span
              v-if="modelValue.filter((f) => f.key === prop.name).length > 0"
              class="text-[10px] px-1.5 py-0.5 bg-primary-100 text-primary-700 rounded-full"
            >
              {{ modelValue.filter((f) => f.key === prop.name).length }}
            </span>
          </button>

          <div
            v-if="expandedProperties.has(prop.name)"
            class="ml-5 mt-0.5 mb-1 flex flex-col gap-0.5"
          >
            <button
              v-for="val in prop.values.slice(0, 20)"
              :key="val"
              @click="toggleFilter(prop.name, val)"
              class="text-left px-2 py-1 rounded-sm text-size-small transition-colors hover:transition-none"
              :class="
                hasActiveFilter(prop.name, val)
                  ? 'bg-primary-100 text-primary-700 font-medium'
                  : 'text-neutral-600 hover:bg-primary-50'
              "
            >
              {{ val }}
            </button>
            <button
              @click="toggleFilter(prop.name, null)"
              class="text-left px-2 py-1 rounded-sm text-size-small italic transition-colors hover:transition-none"
              :class="
                hasActiveFilter(prop.name, null)
                  ? 'bg-primary-100 text-primary-700 font-medium'
                  : 'text-neutral-500 hover:bg-primary-50'
              "
            >
              any value
            </button>
            <span v-if="prop.values.length > 20" class="px-2 text-[10px] text-neutral-400">
              +{{ prop.values.length - 20 }} more
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
