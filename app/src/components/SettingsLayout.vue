<script setup lang="ts">
import { ref, watch } from "vue";

interface Tab {
  id: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    tabs: Tab[];
    modelValue?: string;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const localTab = ref(props.modelValue || props.tabs[0]?.id || "");

watch(
  () => props.modelValue,
  (val: string | undefined) => {
    if (val !== undefined && val !== localTab.value) localTab.value = val;
  },
);

function setTab(id: string) {
  localTab.value = id;
  emit("update:modelValue", id);
}
</script>

<template>
  <div class="flex flex-col sm:flex-row min-h-0 h-full">
    <!-- Nav: horizontal scroll on mobile, vertical sidebar on desktop -->
    <nav
      :class="compact ? 'sm:w-32 p-2' : 'sm:w-44 py-2 sm:pr-1'"
      class="flex sm:flex-col shrink-0 gap-0.5 overflow-x-auto sm:overflow-x-visible border-b sm:border-b-0 border-neutral-100"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        @click="setTab(tab.id)"
        :class="
          localTab === tab.id
            ? 'bg-neutral-100 text-neutral-900 font-medium'
            : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-800'
        "
        class="whitespace-nowrap sm:w-full text-left px-3 py-1.5 text-size-medium rounded-md transition-colors"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- Content -->
    <div
      :class="compact ? 'px-4 py-3' : 'sm:pl-6 py-1'"
      class="flex-1 min-w-0 overflow-y-auto"
    >
      <slot :active-tab="localTab" />
    </div>
  </div>
</template>
