<script setup lang="ts">
import { icons } from "./iconMap.ts";

const props = defineProps<{
  name: keyof typeof icons;
}>();
</script>

<template>
  <div
    v-html="icons[props.name]"
    class="icon flex-none aspect-square [&_svg]:w-full [&_svg]:h-full"
    aria-hidden="true"
  />
</template>
