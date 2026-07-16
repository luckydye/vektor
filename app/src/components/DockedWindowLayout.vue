<script setup lang="ts">
import { computed, watch } from "vue";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useIsDesktop } from "#composeables/useIsDesktop.ts";
import { setDockInsets } from "#utils/insets.ts";

const { leftWindows, rightWindows } = useDockedWindows();
const isDesktop = useIsDesktop();
const RIGHT_DOCK_MARGIN = 6;

// Docked panels reserve edge space through the inset system (not flex
// placeholders): the totals here flow into `--inset-left`/`--inset-right`, and
// content + panels both offset from the same numbers. On mobile the panels
// render as overlay drawers instead of reserving space, so the insets are 0.
const leftDock = computed(() =>
  isDesktop.value ? leftWindows.value.reduce((sum, w) => sum + w.width, 0) : 0,
);
const rightDock = computed(() =>
  isDesktop.value && rightWindows.value.length > 0
    ? rightWindows.value.reduce((sum, w) => sum + w.width, 0) + RIGHT_DOCK_MARGIN
    : 0,
);

watch([leftDock, rightDock], ([l, r]) => setDockInsets(l, r), { immediate: true });
</script>

<template>
  <div class="hidden" aria-hidden="true" />
</template>
