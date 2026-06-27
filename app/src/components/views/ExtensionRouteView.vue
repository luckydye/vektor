<script setup lang="ts">
import { computed } from "vue";
import ExtensionView from "../ExtensionView.vue";
import { useExtensions } from "../../composeables/useExtensions.ts";
import { useSpace } from "../../composeables/useSpace.ts";

const { currentSpace } = useSpace();
const { extensions } = useExtensions();

// Path is everything after /:spaceSlug/x/
const routePath = computed(() => {
  const parts = window.location.pathname.split("/x/");
  return parts[1] ?? "";
});

const match = computed(() => {
  if (!routePath.value) return null;
  for (const ext of extensions.value) {
    for (const route of ext.routes || []) {
      if (routePath.value === route.path || routePath.value.startsWith(route.path + "/")) {
        return { extension: ext, route };
      }
    }
  }
  return null;
});
</script>

<template>
  <div v-if="currentSpace && match" class="min-h-screen h-full flex flex-col relative overflow-x-hidden">
    <div data-inset class="overflow-hidden h-full relative flex-1 md:ml-(--inset-left) my-1.5 md:mr-(--inset-right)">
      <ExtensionView
        :extensionId="match.extension.id"
        :routePath="routePath"
        :spaceId="currentSpace.id"
      />
    </div>
  </div>

</template>
