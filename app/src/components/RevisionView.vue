<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref, watchEffect } from "vue";
import { clockIcon } from "~/src/assets/icons.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { replaceBrowserUrl } from "../utils/browserHistory.ts";
import DiffView from "./DiffView.vue";

const props = defineProps<{
  documentId: string;
  documentType: string;
  spaceId: string;
}>();

const AppView = defineAsyncComponent(() => import("./AppView.vue"));

const { currentSpaceId } = useSpace();

const viewingRevision = ref(false);
const revisionNumber = ref<number | null>(null);
const revisionContent = ref("");
const viewingSuggestion = ref(false);
const showingDiff = ref(false);
const diffPatch = ref("");

type DocumentViewElement = HTMLElement & {
  renderReadHtml?: (html: string) => void;
};
const docViewEl = ref<DocumentViewElement | null>(null);

watchEffect(
  async () => {
    const el = docViewEl.value;
    if (!el) return;
    await customElements.whenDefined("document-view");
    el.renderReadHtml?.(revisionContent.value);
  },
  { flush: "post" },
);

function handleRevisionView(event: CustomEvent) {
  viewingRevision.value = true;
  document.body.dataset.revision = "true";
  revisionNumber.value = event.detail.revision;
  revisionContent.value = event.detail.content;
  viewingSuggestion.value = Boolean(event.detail.isSuggestion);
  showingDiff.value = false;
}

function handleRevisionClose() {
  viewingRevision.value = false;
  document.body.removeAttribute("data-revision");
  revisionNumber.value = null;
  revisionContent.value = "";
  viewingSuggestion.value = false;
  showingDiff.value = false;

  const params = new URLSearchParams(location.search);
  params.delete("revision");
  replaceBrowserUrl(
    `${location.origin}${location.pathname}${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

function closeRevisionView() {
  // Dispatch the event so DocumentContent also clears its viewingRevision flag
  window.dispatchEvent(new CustomEvent("revision:close"));
}

async function handleRevisionDiff(event: CustomEvent) {
  if (!currentSpaceId.value) return;

  try {
    const response = await fetch(
      `/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId}/diff?rev=${event.detail.revision}`,
    );
    if (!response.ok) throw new Error("Failed to fetch diff");

    diffPatch.value = await response.text();
    showingDiff.value = true;
    viewingRevision.value = true;
    document.body.dataset.revision = "true";
    revisionNumber.value = event.detail.revision;
    revisionContent.value = "";
    viewingSuggestion.value = Boolean(event.detail.isSuggestion);
  } catch (error) {
    console.error("Failed to load diff:", error);
  }
}

onMounted(() => {
  window.addEventListener("revision:view", handleRevisionView as EventListener);
  window.addEventListener("revision:close", handleRevisionClose);
  window.addEventListener(
    "revision:diff",
    handleRevisionDiff as unknown as EventListener,
  );
});

onUnmounted(() => {
  window.removeEventListener("revision:view", handleRevisionView as EventListener);
  window.removeEventListener("revision:close", handleRevisionClose);
  window.removeEventListener(
    "revision:diff",
    handleRevisionDiff as unknown as EventListener,
  );
});
</script>

<template>
  <div v-if="viewingRevision">
    <!-- Revision Disclaimer Banner -->
    <div
      class="sticky top-0 z-60 bg-amber-50 border border-amber-200 px-6 py-4 flex items-center justify-between duration-300 mb-10"
    >
      <div class="flex items-center gap-3">
        <div class="svg-icon w-5 h-5 text-amber-600" v-html="clockIcon" />
        <div>
          <p class="text-size-medium font-semibold text-amber-900">
            Viewing {{ viewingSuggestion ? "Suggestion" : "Revision" }} {{ revisionNumber }}
          </p>
          <p class="my-0! text-size-small text-amber-700">
            {{
              viewingSuggestion
                ? "This suggestion is read-only until it is applied."
                : "This is a historical version of the document. Changes cannot be made."
            }}
          </p>
        </div>
      </div>
      <button
        @click="closeRevisionView"
        class="px-4 py-2 text-size-medium font-medium text-amber-900 bg-amber-100 border border-amber-300 rounded-sm hover:bg-amber-200 transition-colors"
      >
        Show published version
      </button>
    </div>

    <!-- Revision View with Diff -->
    <div v-if="showingDiff">
      <DiffView :patch="diffPatch" />
    </div>

    <!-- App Revision View -->
    <div v-else-if="documentType === 'app'" class="h-full">
      <AppView :html="revisionContent" />
    </div>

    <!-- Document / other type Revision View -->
    <div v-else>
      <document-view ref="docViewEl" />
    </div>
  </div>
</template>
