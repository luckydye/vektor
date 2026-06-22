<script setup lang="ts">
import { onMounted, ref } from "vue";
import "@sv/elements/tabs";

interface Tab {
  id: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    tabs: Tab[];
    initialTab?: string;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  "tab-change": [id: string];
}>();

type ATabsEl = HTMLElement & { selectTabByIndex: (index: number, focus?: boolean) => void };
const tabsEl = ref<ATabsEl | null>(null);

function onTabSelected(e: Event) {
  const { index } = (e as CustomEvent<{ index: number }>).detail;
  const tab = props.tabs[index];
  if (tab) emit("tab-change", tab.id);
}

onMounted(() => {
  if (props.initialTab) {
    const i = props.tabs.findIndex((t) => t.id === props.initialTab);
    if (i > 0) tabsEl.value?.selectTabByIndex(i, false);
  }
});
</script>

<template>
  <div class="flex flex-col min-h-0 h-full">
    <a-tabs ref="tabsEl" @tab-selected="onTabSelected">
      <a-tabs-list class="border-b border-neutral-100">
        <a-tabs-tab
          v-for="tab in tabs"
          :key="tab.id"
          class="px-4 py-2.5 text-size-medium text-neutral-500 border-b-2 border-transparent [&[selected]]:text-neutral-900 [&[selected]]:border-neutral-900"
        >{{ tab.label }}</a-tabs-tab>
      </a-tabs-list>
      <a-tabs-panel
        v-for="tab in tabs"
        :key="tab.id"
        :class="[compact ? 'px-4 py-3' : 'py-4', 'block px-2']"
        class="min-w-0"
      >
        <slot :name="tab.id" />
      </a-tabs-panel>
    </a-tabs>
  </div>
</template>
