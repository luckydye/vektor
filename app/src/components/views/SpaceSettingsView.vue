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
  <div v-if="currentSpace" data-inset class="pt-m pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-xl md:ml-(--inset-left) md:mr-(--inset-right)">
    <div class="mb-8">
      <h1 class="text-size-display font-bold text-neutral-900">Space Settings</h1>
      <p class="mt-2 text-size-medium text-neutral-600">
        Space settings for {{ currentSpace.name }}
      </p>
    </div>

    <SpaceSettings v-if="isOwner" />
    <NoAccess v-else />
  </div>
</template>
