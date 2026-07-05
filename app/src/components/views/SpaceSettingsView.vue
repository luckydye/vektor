<script setup lang="ts">
import { computed } from "vue";
import { canAccessSettings } from "../../composeables/usePermissions.ts";
import { useSpace } from "../../composeables/useSpace.ts";
import NoAccess from "../NoAccess.vue";
import SpaceSettings from "../SpaceSettings.vue";

const { currentSpace } = useSpace();
const isOwner = computed(() => canAccessSettings(currentSpace.value?.userRole));
</script>

<template>
  <inset-view v-if="currentSpace" class="block pt-m pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-xl md:ml-(--inset-left) md:mr-(--inset-right)">
    <SpaceSettings v-if="isOwner" />
    <NoAccess v-else />
  </inset-view>
</template>
