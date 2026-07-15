<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import "@atrium-ui/elements/tabs";

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

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};
const tabsEl = ref<ATabsEl | null>(null);
const ready = ref(false);
const selectedIndex = ref(0);

function animatePanel(index: number, direction: "next" | "previous") {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  requestAnimationFrame(() => {
    const panel = tabsEl.value?.querySelectorAll("a-tabs-panel").item(index);
    const content = panel?.firstElementChild as HTMLElement | null;
    if (!content) return;

    for (const animation of content.getAnimations()) animation.cancel();

    const easing = getComputedStyle(document.documentElement)
      .getPropertyValue("--emphasized-curve")
      .trim();
    content.animate(
      [
        {
          opacity: 0,
          transform: `translateX(${direction === "next" ? 8 : -8}px)`,
        },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: 180, easing: easing || "ease-out" },
    );
  });
}

function onTabSelected(e: Event) {
  const { index } = (e as CustomEvent<{ index: number }>).detail;
  if (index !== selectedIndex.value) {
    const direction = index > selectedIndex.value ? "next" : "previous";
    selectedIndex.value = index;
    animatePanel(index, direction);
  }
  const tab = props.tabs[index];
  if (tab) emit("tab-change", tab.id);
}

onMounted(async () => {
  await customElements.whenDefined("a-tabs");
  ready.value = true;
  await nextTick();
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
      <div class="flex h-[51px] items-start gap-[10px] py-4xs">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm"
        >
          <div
            class="h-[26px] rounded-md bg-neutral-100/70 px-3xs py-5xs animate-pulse"
            :style="`width:${tab.label.length * 6 + 24}px`"
          />
        </div>
      </div>
      <div :class="[compact ? 'px-4 py-3' : 'py-4', 'space-y-3']">
        <div class="h-3 w-2/3 rounded bg-neutral-100 animate-pulse" />
        <div class="h-3 w-1/2 rounded bg-neutral-100 animate-pulse" />
        <div class="h-3 w-3/4 rounded bg-neutral-100 animate-pulse" />
      </div>
    </template>

    <a-tabs v-else ref="tabsEl" @tab-selected="onTabSelected">
      <a-tabs-list class="block h-[51px] py-4xs overflow-clip">
        <a-tabs-tab
          v-for="tab in tabs"
          :key="tab.id"
          class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label hover:[&_span]:bg-gray-200 [&[selected]]:opacity-100 opacity-60 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
        >
          <span
            class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
          >
            {{ tab.label }}
          </span>
        </a-tabs-tab>
      </a-tabs-list>
      <a-tabs-panel v-for="tab in tabs" :key="tab.id" class="block min-w-0">
        <div :class="[compact ? 'px-4' : '', 'px-2 py-4']">
          <slot :name="tab.id" />
        </div>
      </a-tabs-panel>
    </a-tabs>
  </div>
</template>
