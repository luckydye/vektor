<script setup lang="ts">
import PinnedDocument from "#components/PinnedDocument.vue";
import RecentDocuments from "#components/RecentDocuments.vue";
import SpaceActivityFeed from "#components/SpaceActivityFeed.vue";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

const { currentSpace } = useSpace();

usePageTitle(null);
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

      <div class="mb-20">
        <SpaceActivityFeed :spaceId="currentSpace.id" :limit="15" />
      </div>
    </inset-view>
  </div>
</template>
