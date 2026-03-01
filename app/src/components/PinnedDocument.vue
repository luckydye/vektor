<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import { api, type DocumentWithProperties } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { canEdit } from "../composeables/usePermissions.ts";
import docStyles from "../styles/document.css?inline";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
  pinnedDocumentId: string;
}>();

const doc = ref<DocumentWithProperties | null>(null);
const viewEl = ref<HTMLElement | null>(null);
const { currentSpace } = useSpace();
const userCanEdit = computed(() => canEdit(currentSpace.value?.userRole));

onMounted(async () => {
  doc.value = await api.document.get(props.spaceId, props.pinnedDocumentId);
});

watch(doc, (d) => {
  if (d) renderContent(d.content ?? "");
});

function renderContent(html: string) {
  const el = viewEl.value;
  if (!el) return;
  const root = (el as any).shadowRoot;
  if (!root) {
    requestAnimationFrame(() => renderContent(html));
    return;
  }
  root.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = docStyles;
  const content = document.createElement("div");
  content.setAttribute("part", "content");
  const inner = document.createElement("div");
  inner.innerHTML = html;
  content.appendChild(inner);
  root.appendChild(style);
  root.appendChild(content);
}

async function unpin() {
  if (!currentSpace.value) throw new Error("No space loaded");
  await api.space.patch(currentSpace.value.id, { preferences: { pinnedDocumentId: "" } });
  window.location.reload();
}
</script>

<template>
  <div class="overflow-hidden mb-10">
    <div class="flex items-center justify-between">
      <a
        :href="doc ? `/${spaceSlug}/doc/${doc.slug}` : undefined"
        class="flex items-center gap-2 group"
      >
        <svg class="w-3.5 h-3.5 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
        </svg>
        <span class="text-xs font-semibold text-amber-600 uppercase tracking-wide">Pinned</span>
        <span v-if="doc" class="text-sm font-semibold text-neutral-800 group-hover:text-blue-600 transition-colors">
          {{ doc.properties?.title || 'Untitled' }}
        </span>
        <span v-else class="h-4 w-40 bg-amber-100 animate-pulse rounded"></span>
      </a>
      <button
        v-if="userCanEdit"
        @click="unpin"
        class="text-xs text-neutral-400 hover:text-neutral-700 transition-colors"
      >
        Unpin
      </button>
    </div>

    <div class="relative overflow-hidden">
      <document-view ref="viewEl" class="block"></document-view>
    </div>
  </div>
</template>
