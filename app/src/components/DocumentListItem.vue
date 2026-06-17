<script setup lang="ts">
import { computed } from "vue";
import { documentIcon } from "~/src/assets/icons.ts";
import type { DocumentWithProperties, SearchResult } from "../api/client.ts";
import { formatDate } from "../utils/utils.ts";

const props = defineProps<{
  document: SearchResult | DocumentWithProperties;
  spaceSlug: string;
  showSnippet?: boolean;
  searchQuery?: string;
  selected?: boolean;
  selectable?: boolean;
}>();

const emit = defineEmits<{
  "toggle-select": [id: string];
}>();

const title = computed(() => {
  if ("properties" in props.document && props.document.properties) {
    return (
      props.document.properties.title ||
      props.document.properties.name ||
      "Untitled"
    );
  }
  return "Untitled";
});

const docType = computed(() => props.document.type || "document");

const TYPE_STYLES: Record<string, string> = {
  canvas:   "bg-violet-100 text-violet-600",
  csv:      "bg-emerald-100 text-emerald-700",
  file:     "bg-neutral-100 text-neutral-500",
  document: "bg-neutral-100 text-neutral-500",
};

const typeStyle = computed(
  () => TYPE_STYLES[docType.value] ?? "bg-neutral-100 text-neutral-500",
);

const visibleProperties = computed(() => {
  if (!("properties" in props.document) || !props.document.properties) return [];
  const excluded = ["title", "name"];
  return Object.entries(props.document.properties).filter(
    ([key, value]) =>
      !excluded.includes(key) &&
      value !== null &&
      value !== undefined &&
      value !== "",
  );
});

const isSearchResult = (
  doc: SearchResult | DocumentWithProperties,
): doc is SearchResult => "rank" in doc && "snippet" in doc;
</script>

<template>
  <page-target
    :data-document-id="document.id"
    class="block [&[data-drag-over]]:bg-neutral-100 [&[data-dragging]]:opacity-50"
  >
    <div
      class="grid grid-cols-[32px_1fr_80px_200px_140px] border-b border-neutral-100 group transition-colors hover:transition-none"
      :class="selected ? 'bg-primary-50' : 'hover:bg-neutral-50'"
    >
      <!-- Checkbox -->
      <div
        class="flex items-start py-3.5 justify-center self-stretch transition-opacity"
        :class="selectable || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        @click.stop
      >
        <input
          type="checkbox"
          :checked="selected"
          @change="emit('toggle-select', document.id)"
          class="w-3.5 h-3.5 accent-primary-500 cursor-pointer"
        />
      </div>

      <!-- Link spans remaining 4 columns -->
      <a
        :href="document.fileUrl ?? `/${spaceSlug}/doc/${document.slug}`"
        :target="document.fileUrl ? '_blank' : undefined"
        :rel="document.fileUrl ? 'noopener noreferrer' : undefined"
        class="col-span-4 grid grid-cols-[1fr_80px_200px_140px] items-start min-w-0"
      >
        <!-- Title -->
        <div class="flex items-center gap-2.5 py-2.5 pr-3 min-w-0">
          <div
            class="svg-icon w-4 h-4 shrink-0 text-neutral-300 group-hover:text-neutral-400 transition-colors"
            v-html="documentIcon"
          />
          <div class="flex-1 min-w-0">
            <span class="text-size-medium font-medium text-neutral-800 truncate block">
              {{ title }}
            </span>
            <div
              v-if="showSnippet && isSearchResult(document) && document.snippet"
              class="text-size-small text-neutral-400 truncate mt-0.5 [&_mark]:bg-transparent [&_mark]:text-neutral-600 [&_mark]:font-medium"
              v-html="document.snippet"
            />
          </div>
        </div>

        <!-- Type -->
        <div class="flex items-center py-2.5 pr-3">
          <span
            class="px-1.5 py-0.5 rounded-sm text-[11px] font-medium capitalize"
            :class="typeStyle"
          >
            {{ docType }}
          </span>
        </div>

        <!-- Properties -->
        <div class="flex items-center gap-1 flex-wrap pr-3 py-2.5 min-w-0">
          <span
            v-for="[key, value] in visibleProperties"
            :key="key"
            class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-neutral-100 rounded-sm text-[11px] text-neutral-500 min-w-0 max-w-[160px]"
            :title="`${key}: ${value}`"
          >
            <span class="text-neutral-400 shrink-0 truncate max-w-[60px]">{{ key }}</span>
            <span class="truncate">{{ value }}</span>
          </span>
        </div>

        <!-- Modified date -->
        <div class="py-2.5 pr-4 text-right">
          <span class="text-size-small text-neutral-400 tabular-nums">
            {{ formatDate(document.updatedAt) }}
          </span>
        </div>
      </a>
    </div>
  </page-target>
</template>
