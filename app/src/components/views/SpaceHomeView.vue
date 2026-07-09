<script setup lang="ts">
import { computed } from "vue";
import ExtensionView from "#components/ExtensionView.vue";
import PinnedDocument from "#components/PinnedDocument.vue";
import RecentDocuments from "#components/RecentDocuments.vue";
import SpaceActivityFeed from "#components/SpaceActivityFeed.vue";
import { useExtensions } from "#composeables/useExtensions.ts";
import { useSpace } from "#composeables/useSpace.ts";

const { currentSpace } = useSpace();
const { extensions } = useExtensions();

const homeTopViews = computed(() =>
  extensions.value.flatMap((ext) =>
    (ext.routes || [])
      .filter((route) => route.placements?.includes("home-top"))
      .map((route) => ({ extensionId: ext.id, route })),
  ),
);
</script>

<template>
  <div
    v-if="currentSpace"
    class="min-h-screen h-full flex flex-col relative overflow-x-hidden"
  >
    <inset-view
      class="block space-y-12 pt-m pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-xl md:ml-(--inset-left) md:mr-(--inset-right)"
    >
      <PinnedDocument
        v-if="currentSpace.preferences.pinnedDocumentId"
        :spaceId="currentSpace.id"
        :pinnedDocumentId="currentSpace.preferences.pinnedDocumentId"
      />

      <div>
        <RecentDocuments :spaceId="currentSpace.id" :limit="10" />
      </div>

      <div v-if="homeTopViews.length > 0" class="space-y-4 mb-20">
        <div
          v-for="{ extensionId, route } in homeTopViews"
          :key="`${extensionId}-${route.path}`"
        >
          <div v-if="route.title || route.description" class="mb-3">
            <h3 v-if="route.title" class="text-size-title">{{ route.title }}</h3>
            <p v-if="route.description" class="text-size-medium text-neutral-600 mt-1">
              {{ route.description }}
            </p>
          </div>
          <ExtensionView
            :extensionId="extensionId"
            :routePath="route.path"
            :spaceId="currentSpace.id"
          />
        </div>
      </div>

      <div class="mb-20">
        <SpaceActivityFeed :spaceId="currentSpace.id" :limit="15" />
      </div>
    </inset-view>
  </div>
</template>
