<script setup lang="ts">
import type { ExtensionRoute } from "#api/client.ts";
import ExtensionView from "#components/ExtensionView.vue";

defineProps<{
  spaceId: string;
  views: Array<{ extensionId: string; route: ExtensionRoute }>;
}>();
</script>

<template>
  <aside v-if="views.length > 0" class="hidden min-w-0 space-y-4 lg:block">
    <ExtensionView
      v-for="{ extensionId, route } in views"
      :key="`${extensionId}-${route.path}`"
      :extensionId="extensionId"
      :routePath="route.path"
      :spaceId="spaceId"
    />
  </aside>
</template>
