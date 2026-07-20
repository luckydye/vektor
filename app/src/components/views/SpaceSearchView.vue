<script setup lang="ts">
import Search from "#components/Search.vue";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

const { currentSpace } = useSpace();

usePageTitle("Search");
</script>

<template>
  <inset-view
    v-if="currentSpace"
    class="block pt-xs pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-m md:ml-(--inset-left) md:mr-(--inset-right)"
  >
    <Search :spaceId="currentSpace.id" />
  </inset-view>
</template>
