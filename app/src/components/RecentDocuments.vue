<script setup lang="ts">
import "@atrium-ui/elements/track";
import { computed } from "vue";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { spacePath } from "#utils/utils.ts";
import DocumentTeaser from "./DocumentTeaser.vue";

const props = defineProps<{
  spaceId: string;
  limit?: number;
}>();

const { currentSpace } = useSpace();

const TEASER_TYPES = new Set(["document", "canvas", "database"]);
const count = props.limit ?? 5;

const { data: docsData, isPending: loading } = useQuery({
  queryKey: computed(() => ["wiki_documents_recent", props.spaceId, count]),
  queryFn: async () => {
    const result = await api.documents.get(props.spaceId, { limit: count });
    return result.documents.filter((d) => TEASER_TYPES.has(d.type ?? "document"));
  },
});

const docs = computed(() => docsData.value ?? []);
</script>

<template>
  <div>
    <h2 class="text-size-label mb-4">Recently Modified</h2>

    <div class="h-60">
    <!-- Skeleton -->
    <div v-if="loading" class="flex h-full overflow-hidden">
      <div v-for="i in count" :key="i" class="flex-none w-60 pr-4">
        <div class="aspect-video bg-neutral-100 animate-pulse rounded-xl" />
        <div class="mt-3 space-y-2">
          <div class="h-3 w-20 bg-neutral-100 animate-pulse rounded" />
          <div class="h-5 w-full bg-neutral-100 animate-pulse rounded" />
          <div class="h-3 w-3/4 bg-neutral-100 animate-pulse rounded" />
        </div>
      </div>
    </div>

    <div v-else-if="docs.length === 0" class="h-full text-size-small text-neutral-400">
      No documents yet.
    </div>

    <!-- Slider -->
    <a-track v-else snap class="flex h-full w-full overflow-visible">
      <DocumentTeaser v-for="doc in docs" :key="doc.id" :doc="doc" />

      <!-- Trailing "view all" card -->
      <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
      <a
        :href="spacePath(currentSpace?.slug, '/search')"
        class="group flex-none w-60 block pr-4"
      >
        <div class="aspect-video rounded-xl border-2 border-dashed border-neutral-200 flex items-center justify-center group-hover:border-neutral-300 transition-colors">
          <span class="text-neutral-400 group-hover:text-neutral-500 transition-colors text-sm font-medium">View all →</span>
        </div>
        <div class="mt-3">
          <h4 class="text-size-medium font-bold italic leading-snug" style="color: var(--color-primary-700)">Browse all documents</h4>
        </div>
      </a>
    </a-track>
    </div>
  </div>
</template>
