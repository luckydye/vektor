<script setup lang="ts">
import { computed, ref } from "vue";
import {
  chevronDownIcon,
  chevronRightThinIcon,
  closeXIcon,
  plusIcon,
} from "~/src/assets/icons.ts";
import { api, type PropertyFilter } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import "@atrium-ui/elements/popover";

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
    return properties.filter((p) => p.name !== "title" && !p.name.startsWith("_"));
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
  file: "bg-neutral-100 text-neutral-600",
  document: "bg-neutral-100 text-neutral-600",
};

const activeDateFilter = computed(
  () => props.modelValue.find((f) => f.key === DATE_FILTER_KEY)?.value ?? null,
);

const activePropertyFilters = computed(
  () => props.modelValue.filter((f) => f.key !== DATE_FILTER_KEY && f.key !== "type"),
);

const hasActiveFilter = (key: string, value: string | null) =>
  props.modelValue.some((f) => f.key === key && f.value === value);

const addFilter = (key: string, value: string | null) => {
  if (hasActiveFilter(key, value)) return;
  emit("update:modelValue", [...props.modelValue, { key, value }]);
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

const setDateFilter = (value: string, event: MouseEvent) => {
  const withoutDate = props.modelValue.filter((f) => f.key !== DATE_FILTER_KEY);
  if (activeDateFilter.value === value) {
    emit("update:modelValue", withoutDate);
  } else {
    emit("update:modelValue", [...withoutDate, { key: DATE_FILTER_KEY, value }]);
  }
  (event.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
  emit("search");
};

const clearDateFilter = (event: MouseEvent) => {
  event.stopPropagation();
  emit(
    "update:modelValue",
    props.modelValue.filter((f) => f.key !== DATE_FILTER_KEY),
  );
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

const chipBase = "flex items-center gap-1 py-1 px-3xs text-interactive rounded-lg border transition-colors text-size-small";
const chipInactive = "bg-background border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:bg-primary-10";
const chipActive = "bg-primary-50 border-primary-200 text-primary-700 hover:bg-primary-100";

const popoverPanel = "w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100";
const popoverInner = "bg-background border border-neutral-100 rounded-lg origin-top-left scale-95 transition-all shadow-large duration-150 group-[[enabled]]:scale-100 overflow-hidden";
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 select-none">

    <!-- Date filter chip -->
    <a-popover-trigger class="group">
      <button
        slot="trigger"
        :class="[chipBase, activeDateFilter ? chipActive : chipInactive]"
      >
        <span>{{ activeDateFilter ? `Modified: ${dateLabel(activeDateFilter)}` : "Modified" }}</span>
        <button v-if="activeDateFilter" @click="clearDateFilter" class="hover:opacity-70 flex-none">
          <div class="svg-icon w-3 h-3" v-html="closeXIcon" />
        </button>
        <div v-else class="svg-icon w-3 h-3 opacity-40" v-html="chevronDownIcon" />
      </button>

      <a-popover class="group" placements="bottom-start">
        <div :class="popoverPanel">
          <div :class="[popoverInner, 'min-w-[130px] p-1']">
            <button
              v-for="df in DATE_FILTERS"
              :key="df.value"
              @click="setDateFilter(df.value, $event)"
              class="w-full text-left px-3 py-1.5 rounded-md text-size-small transition-colors hover:transition-none"
              :class="activeDateFilter === df.value ? 'bg-primary-100 text-primary-700 font-medium' : 'text-neutral-700 hover:bg-primary-50'"
            >
              {{ df.label }}
            </button>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>

    <!-- Type filter chips -->
    <template v-if="typeValues.length > 0">
      <button
        v-for="tv in typeValues"
        :key="tv"
        @click="toggleFilter('type', tv)"
        :class="[
          chipBase,
          'capitalize',
          hasActiveFilter('type', tv)
            ? (TYPE_STYLES[tv] ?? 'bg-neutral-100 text-neutral-600') + ' border-transparent'
            : chipInactive,
        ]"
      >
        {{ tv }}
        <button
          v-if="hasActiveFilter('type', tv)"
          @click.stop="removeFilterByKeyValue('type', tv)"
          class="hover:opacity-70 flex-none"
        >
          <div class="svg-icon w-3 h-3" v-html="closeXIcon" />
        </button>
      </button>
    </template>

    <!-- Active property filter chips -->
    <div
      v-for="filter in activePropertyFilters"
      :key="filter.key + (filter.value ?? '_exists')"
      :class="[chipBase, chipActive]"
    >
      <span class="font-medium">{{ filter.key }}</span>
      <span class="opacity-40">:</span>
      <span :class="filter.value === null ? 'italic opacity-70' : ''">{{ filter.value ?? "exists" }}</span>
      <button @click="removeFilterByKeyValue(filter.key, filter.value)" class="ml-0.5 hover:opacity-70 flex-none">
        <div class="svg-icon w-3 h-3" v-html="closeXIcon" />
      </button>
    </div>

    <!-- Add property filter -->
    <a-popover-trigger v-if="nonTypeProperties.length > 0" class="group">
      <button
        slot="trigger"
        class="flex items-center gap-1 py-1 px-3xs text-interactive rounded-lg border border-dashed border-neutral-300 text-neutral-500 hover:border-primary-300 hover:text-primary-600 transition-colors text-size-small"
      >
        <div class="svg-icon w-3.5 h-3.5" v-html="plusIcon" />
        <span>Filter</span>
      </button>

      <a-popover class="group" placements="bottom-start">
        <div :class="popoverPanel">
          <div :class="[popoverInner, 'w-52']">
            <div class="px-3 py-2 border-b border-neutral-100">
              <span class="text-[11px] font-medium text-neutral uppercase tracking-wider">Properties</span>
            </div>
            <div class="py-1 max-h-64 overflow-y-auto">
              <div v-for="prop in nonTypeProperties" :key="prop.name" class="px-1">
                <button
                  @click="toggleProperty(prop.name)"
                  class="w-full text-left px-3 py-1.5 rounded-md flex items-center gap-2 text-size-small text-neutral-700 hover:bg-primary-50 transition-colors hover:transition-none"
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

                <div v-if="expandedProperties.has(prop.name)" class="ml-5 mt-0.5 mb-1 flex flex-col gap-0.5">
                  <button
                    v-for="val in prop.values.slice(0, 20)"
                    :key="val"
                    @click="toggleFilter(prop.name, val)"
                    class="text-left px-2 py-1 rounded-sm text-size-small transition-colors hover:transition-none"
                    :class="hasActiveFilter(prop.name, val) ? 'bg-primary-100 text-primary-700 font-medium' : 'text-neutral-600 hover:bg-primary-50'"
                  >
                    {{ val }}
                  </button>
                  <button
                    @click="toggleFilter(prop.name, null)"
                    class="text-left px-2 py-1 rounded-sm text-size-small italic transition-colors hover:transition-none"
                    :class="hasActiveFilter(prop.name, null) ? 'bg-primary-100 text-primary-700 font-medium' : 'text-neutral-500 hover:bg-primary-50'"
                  >
                    any value
                  </button>
                  <span v-if="prop.values.length > 20" class="px-2 text-[10px] text-neutral-400">
                    +{{ prop.values.length - 20 }} more
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>

    <!-- Clear all -->
    <button
      v-if="hasAnyFilters"
      @click="clearAll"
      class="text-[11px] text-neutral hover:text-neutral-800 transition-colors ml-1"
    >
      Clear all
    </button>
  </div>
</template>
