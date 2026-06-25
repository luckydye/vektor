<script setup lang="ts">
import "@atrium-ui/elements/track";
import { onMounted, ref } from "vue";
import type { DocumentWithProperties } from "../api/client.ts";
import { api } from "../api/client.ts";
import { withTransformParams } from "../files/transformUrl.ts";
import { formatDate } from "../utils/utils.ts";

function teaserImageUrl(url: string): string {
  return withTransformParams(url, { w: 400, format: "webp" });
}

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
  limit?: number;
}>();

const docs = ref<DocumentWithProperties[]>([]);
const loading = ref(true);

const count = props.limit ?? 5;

function docTitle(doc: DocumentWithProperties) {
  return doc.properties?.title || doc.properties?.name || "Untitled";
}

function docTags(doc: DocumentWithProperties): string[] {
  if (!doc.properties) return [];
  const excluded = new Set(["title", "name", "headerImage"]);
  return Object.entries(doc.properties)
    .filter(([k, v]) => !excluded.has(k) && v)
    .map(([, v]) => String(v));
}

const TEASER_TYPES = new Set(["document", "canvas", "database"]);

onMounted(async () => {
  const result = await api.documents.get(props.spaceId, { limit: count });
  docs.value = result.documents.filter((d) => TEASER_TYPES.has(d.type ?? "document"));
  loading.value = false;
});
</script>

<template>
  <div>
    <h2 class="text-size-title mb-4">Recently Modified</h2>

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
      <a
        v-for="doc in docs"
        :key="doc.id"
        :href="doc.fileUrl ?? `/${spaceSlug}/doc/${doc.slug}`"
        :target="doc.fileUrl ? '_blank' : undefined"
        :rel="doc.fileUrl ? 'noopener noreferrer' : undefined"
        class="group flex-none w-60 block pr-4"
      >
        <!-- Thumbnail -->
        <div class="relative aspect-video rounded-xl bg-neutral-200 overflow-hidden flex items-center justify-center">
          <img
            v-if="doc.properties?.headerImage"
            :src="teaserImageUrl(doc.properties.headerImage)"
            class="absolute inset-0 w-full h-full object-cover"
            alt=""
          />
          <span v-else class="text-neutral-400 text-sm font-medium select-none">
            {{ doc.type ? doc.type.toUpperCase() : "DOC" }}
          </span>
          <div
            v-if="docTags(doc).length > 0"
            class="absolute bottom-3 left-3 right-3 flex gap-1.5 min-w-0 max-w-full"
          >
            <span
              v-for="(tag, i) in docTags(doc).slice(0, 1)"
              :key="i"
              class="px-2.5 py-1 rounded-full bg-neutral-10 text-neutral-700 text-[11px] font-medium shadow-sm min-w-0 max-w-full truncate"
              :title="tag"
            >
              {{ tag }}
            </span>
            <span
              v-if="docTags(doc).length > 1"
              class="px-2.5 py-1 rounded-full bg-neutral-10 text-neutral-700 text-[11px] font-medium shadow-sm shrink-0"
            >
              +{{ docTags(doc).length - 1 }}
            </span>
          </div>
        </div>

        <!-- Body -->
        <div class="mt-3">
          <p class="text-[11px] font-semibold text-neutral-500 tabular-nums mb-1">
            {{ formatDate(doc.updatedAt) }}
          </p>
          <h4 class="doc-title text-size-medium font-bold italic leading-snug line-clamp-3 transition-colors">
            {{ docTitle(doc) }}
          </h4>
          <p
            v-if="docTags(doc).length > 0"
            class="mt-1.5 text-size-small text-neutral-400 line-clamp-2 min-w-0 break-words"
            :title="docTags(doc).join(' | ')"
          >
            {{ docTags(doc).join(" | ") }}
          </p>
        </div>
      </a>

      <!-- Trailing "view all" card -->
      <a
        :href="`/${spaceSlug}/search`"
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

<style scoped>
.doc-title {
  color: var(--color-primary-700);
}
a:hover .doc-title {
  color: var(--color-primary-500);
}
</style>
