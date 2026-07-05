<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useExtensions } from "../../composeables/useExtensions.ts";
import { useSpace } from "../../composeables/useSpace.ts";
import ExtensionView from "../ExtensionView.vue";

const { currentSpace } = useSpace();
const { extensions } = useExtensions();
const vueRoute = useRoute();

const routePath = computed(() => (vueRoute.params.pathMatch as string[]).join("/"));

const match = computed(() => {
  if (!routePath.value) return null;
  for (const ext of extensions.value) {
    for (const route of ext.routes || []) {
      if (
        routePath.value === route.path ||
        routePath.value.startsWith(route.path + "/")
      ) {
        return { extension: ext, route };
      }
    }
  }
  return null;
});
</script>

<template>
  <div class="min-h-screen h-full flex flex-col relative overflow-x-hidden">
    <inset-view class="block overflow-hidden h-full relative flex-1 md:ml-(--inset-left) my-1.5 md:mr-(--inset-right)">
      <ExtensionView
        v-if="currentSpace && match"
        :extensionId="match.extension.id"
        :routePath="routePath"
        :spaceId="currentSpace.id"
      />
    </inset-view>
  </div>
</template>
