<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { pinPushpinIcon } from "~/src/assets/icons.ts";
import { api, type DocumentWithProperties } from "../api/client.ts";
import { canEdit } from "../composeables/usePermissions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import docStyles from "../styles/document.css?inline";

const props = defineProps<{
  spaceId: string;
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
  if (d && (!d.type || d.type === "document")) renderContent(d.content ?? "");
});

function renderContent(html: string) {
  const el = viewEl.value;
  if (!el) return;
  const root = (el as Element).shadowRoot;
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
        :href="doc ? `/doc/${doc.slug}` : undefined"
        class="flex items-center gap-2 group"
      >
        <div class="svg-icon w-3.5 h-3.5 text-amber-500 shrink-0" v-html="pinPushpinIcon" />
        <span class="text-size-small font-semibold text-amber-600 uppercase tracking-wide">Pinned</span>
        <span v-if="doc" class="text-size-medium font-semibold text-neutral-800 group-hover:text-blue-600 transition-colors">
          {{ doc.properties?.title || 'Untitled' }}
        </span>
        <span v-else class="h-4 w-40 bg-amber-100 animate-pulse rounded-sm"></span>
      </a>
      <button
        v-if="userCanEdit"
        @click="unpin"
        class="text-size-small text-neutral-400 hover:text-neutral-700 transition-colors"
      >
        Unpin
      </button>
    </div>

    <div class="relative overflow-hidden">
      <template v-if="doc && doc.type && doc.type !== 'document'">
        <a
          :href="`/doc/${doc.slug}`"
          class="mt-3 flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 hover:bg-neutral-100 transition-colors"
        >
          <span class="text-size-medium font-medium text-neutral-800">{{ doc.properties?.title || 'Untitled' }}</span>
          <span class="ml-auto text-size-small text-neutral-400 capitalize">{{ doc.type }}</span>
        </a>
      </template>
      <document-view v-else ref="viewEl" class="block"></document-view>
    </div>
  </div>
</template>
