<script setup lang="ts">
import Search from "../Search.vue";
import { useSpace } from "../../composeables/useSpace.ts";

const { currentSpace } = useSpace();
</script>

<template>
  <div v-if="currentSpace" data-inset class="pt-m pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-xl md:ml-(--inset-left) md:mr-(--inset-right)">
    <Search :spaceId="currentSpace.id" />
  </div>

</template>
