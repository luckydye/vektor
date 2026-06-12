<script setup lang="ts">
import { computed, watch } from "vue";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";
import { setDockInsets } from "../utils/insets.ts";

const { leftWindows, rightWindows } = useDockedWindows();

// Docked panels reserve edge space through the inset system (not flex
// placeholders): the totals here flow into `--inset-left`/`--inset-right`, and
// content + panels both offset from the same numbers.
const leftDock = computed(() => leftWindows.value.reduce((sum, w) => sum + w.width, 0));
const rightDock = computed(() => rightWindows.value.reduce((sum, w) => sum + w.width, 0));

watch([leftDock, rightDock], ([l, r]) => setDockInsets(l, r), { immediate: true });
</script>

<template>
  <div class="hidden" aria-hidden="true" />
</template>
