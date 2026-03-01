<script setup lang="ts">
import { useDockedWindows } from "../composeables/useDockedWindows.ts";

const { leftWindows, rightWindows } = useDockedWindows();
</script>

<template>
  <div class="flex min-h-screen h-full ml-3">
    <!-- Left docked placeholders -->
    <div
      v-for="w in leftWindows"
      :key="w.id"
      :data-docked-id="w.id"
      class="shrink-0"
      :style="{ width: w.width + 'px' }"
    />

    <!-- Main content -->
    <div class="flex-1 min-w-0 flex flex-col relative">
      <slot />
    </div>

    <!-- Right docked placeholders -->
    <div
      v-for="w in rightWindows"
      :key="w.id"
      :data-docked-id="w.id"
      class="shrink-0"
      :style="{ width: w.width + 'px' }"
    />
  </div>
</template>
