<script setup lang="ts">
import NoAccess from "../NoAccess.vue";
import SpaceSettings from "../SpaceSettings.vue";
import { useSpace } from "../../composeables/useSpace.ts";
import { canAccessSettings } from "../../composeables/usePermissions.ts";
import { computed } from "vue";

const { currentSpace } = useSpace();
const isOwner = computed(() => canAccessSettings(currentSpace.value?.userRole));
</script>

<template>
  <inset-view v-if="currentSpace" class="block pt-m pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-xl md:ml-(--inset-left) md:mr-(--inset-right)">
    <SpaceSettings v-if="isOwner" />
    <NoAccess v-else />
  </inset-view>
</template>
