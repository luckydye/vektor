<script setup lang="ts">
import type { SearchResult, DocumentWithProperties } from "../api/client.ts";
import { formatDate } from "../utils/utils.ts";

const props = defineProps<{
  document: SearchResult | DocumentWithProperties;
  spaceSlug: string;
  showRank?: boolean;
  showSnippet?: boolean;
  searchQuery?: string;
}>();

const getDocumentTitle = (doc: SearchResult | DocumentWithProperties): string => {
  if ("properties" in doc && doc.properties) {
    return doc.properties.title || doc.properties.name || "Untitled";
  }
  return "Untitled";
};

const getVisibleProperties = (doc: SearchResult | DocumentWithProperties) => {
  if (!("properties" in doc) || !doc.properties) return [];

  const excludedKeys = ["title", "name"];
  return Object.entries(doc.properties).filter(
    ([key, value]) =>
      !excludedKeys.includes(key) &&
      value !== null &&
      value !== undefined &&
      value !== "",
  );
};

const isSearchResult = (
  doc: SearchResult | DocumentWithProperties,
): doc is SearchResult => {
  return "rank" in doc && "snippet" in doc;
};
</script>

<template>
  <page-target
    :data-document-id="document.id"
    class="block [&[data-drag-over]]:bg-neutral-100 [&[data-dragging]]:opacity-50"
  >
    <a 
      :href="`/${spaceSlug}/doc/${document.slug}`" 
      class="block py-4 px-2 border-b border-t border-neutral-100 bg-background hover:border-blue-500 transition-all"
      :class="showSnippet ? 'hover:bg-blue-50/30' : 'hover:bg-neutral-50'"
    >
        
        <div class="flex items-center gap-4 flex-wrap text-xs text-neutral-500 mb-3">
          <span class="flex items-center gap-1.5">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Updated {{ formatDate(document.updatedAt) }}
          </span>
          <span
            v-for="[key, value] in getVisibleProperties(document)"
            :key="key"
            class="inline-flex items-center gap-1 px-2 py-1 bg-neutral-100 rounded font-medium"
            :title="`${key}: ${value}`"
          >
            <span class="text-neutral-400 text-xs capitalize">{{ key }}:</span>
            <span class="text-neutral-700">{{ value }}</span>
          </span>
        </div>
        
      <div class="flex justify-between items-start gap-4 mb-2">
        <h3 class="text-lg font-semibold text-neutral-900 leading-tight">
          {{ getDocumentTitle(document) }}
        </h3>
      </div>

      <div 
        v-if="showSnippet && isSearchResult(document)" 
        class="mb-3 leading-relaxed text-neutral-600 text-sm [&_mark]:bg-amber-100 [&_mark]:px-0.5 [&_mark]:rounded [&_mark]:font-medium [&_mark]:text-amber-800" 
      >
        <document-view>
            <template v-html="document.snippet"></template>
        </document-view>
      </div>
    </a>
  </page-target>
</template>