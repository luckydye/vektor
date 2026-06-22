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
const ready = ref(false);

function onTabSelected(e: Event) {
  const { index } = (e as CustomEvent<{ index: number }>).detail;
  const tab = props.tabs[index];
  if (tab) emit("tab-change", tab.id);
}

onMounted(async () => {
  await customElements.whenDefined("a-tabs");
  ready.value = true;
  if (props.initialTab) {
    const i = props.tabs.findIndex((t) => t.id === props.initialTab);
    if (i > 0) tabsEl.value?.selectTabByIndex(i, false);
  }
});
</script>

<template>
  <div class="flex flex-col min-h-0 h-full">
    <!-- Skeleton shown until a-tabs upgrades -->
    <template v-if="!ready">
      <div class="flex border-b border-neutral-100">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="px-4 py-3 border-b-2 border-transparent"
        >
          <div class="h-3.5 rounded bg-neutral-100 animate-pulse" :style="`width:${tab.label.length * 7}px`" />
        </div>
      </div>
      <div :class="[compact ? 'px-4 py-3' : 'py-4', 'space-y-3']">
        <div class="h-3 w-2/3 rounded bg-neutral-100 animate-pulse" />
        <div class="h-3 w-1/2 rounded bg-neutral-100 animate-pulse" />
        <div class="h-3 w-3/4 rounded bg-neutral-100 animate-pulse" />
      </div>
    </template>

    <a-tabs v-else ref="tabsEl" @tab-selected="onTabSelected">
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
        class="block min-w-0"
      >
        <div :class="[compact ? 'px-4' : '', 'px-2 py-4']">
            <slot :name="tab.id" />
        </div>
      </a-tabs-panel>
    </a-tabs>
  </div>
</template>
