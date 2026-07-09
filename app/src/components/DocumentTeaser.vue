<script setup lang="ts">
import type { DocumentWithProperties } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import { propertyValueToText } from "#utils/documentProperties.ts";
import { formatDate, spacePath } from "#utils/utils.ts";

defineProps<{
  doc: DocumentWithProperties;
}>();

const { currentSpace } = useSpace();

function teaserImageUrl(url: string): string {
  return withTransformParams(url, { w: 400, format: "webp" });
}

function docHeaderImage(doc: DocumentWithProperties): string | null {
  const headerImage = doc.properties?.headerImage;
  if (Array.isArray(headerImage)) return headerImage[0] ?? null;
  return headerImage ?? null;
}

function docTitle(doc: DocumentWithProperties) {
  const title = doc.properties?.title ?? doc.properties?.name;
  return title ? propertyValueToText(title) : "Untitled";
}

function docTags(doc: DocumentWithProperties): string[] {
  if (!doc.properties) return [];
  const excluded = new Set(["title", "name", "headerImage"]);
  return Object.entries(doc.properties)
    .filter(([k, v]) => !excluded.has(k) && v)
    .flatMap(([, v]) => (Array.isArray(v) ? v : [propertyValueToText(v)]));
}
</script>

<template>
  <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
  <a
    :href="doc.fileUrl ?? spacePath(currentSpace?.slug, `/doc/${doc.slug}`)"
    :target="doc.fileUrl ? '_blank' : undefined"
    :rel="doc.fileUrl ? 'noopener noreferrer' : undefined"
    class="group flex-none w-60 block pr-4"
  >
    <!-- Thumbnail -->
    <div
      class="relative aspect-video rounded-xl bg-neutral-200 overflow-hidden flex items-center justify-center"
    >
      <img
        v-if="docHeaderImage(doc)"
        :src="teaserImageUrl(docHeaderImage(doc)!)"
        class="absolute inset-0 w-full h-full object-cover"
        alt=""
      >
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
      <h4
        class="doc-title text-size-medium font-bold italic leading-snug line-clamp-3 transition-colors"
      >
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
</template>

<style scoped>
.doc-title {
  color: var(--color-primary-700);
}
a:hover .doc-title {
  color: var(--color-primary-500);
}
</style>
