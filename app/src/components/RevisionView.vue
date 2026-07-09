<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import { useSpace } from "#composeables/useSpace.ts";
import { replaceBrowserUrl } from "#utils/browserHistory.ts";
import { clockIcon } from "~/src/assets/icons.ts";
import AppView from "./AppView.vue";

const props = defineProps<{
  documentId: string;
  documentType: string;
  spaceId: string;
}>();

const { currentSpaceId } = useSpace();

const viewingRevision = ref(false);
const revisionNumber = ref<number | null>(null);
const revisionContent = ref("");
const viewingSuggestion = ref(false);
const showingDiff = ref(false);
const diffContent = ref("");

// When viewing a diff the document element renders the inline redline instead
// of the plain revision content; otherwise it renders the revision as-is.
const renderedHtml = computed(() =>
  showingDiff.value ? diffContent.value : revisionContent.value,
);

type DocumentViewElement = HTMLElement & {
  renderReadHtml?: (html: string) => void;
};
const docViewEl = ref<DocumentViewElement | null>(null);

watchEffect(
  async () => {
    // Read both reactive deps synchronously: reads after an `await` are not
    // tracked, so the effect must depend on `renderedHtml` here to re-run when
    // the content changes (e.g. switching from a revision view to its diff)
    // and not only when the element mounts.
    const el = docViewEl.value;
    const html = renderedHtml.value;
    if (!el) return;
    await customElements.whenDefined("document-view");
    el.renderReadHtml?.(html);
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
  diffContent.value = "";
}

function handleRevisionClose() {
  viewingRevision.value = false;
  document.body.removeAttribute("data-revision");
  revisionNumber.value = null;
  revisionContent.value = "";
  viewingSuggestion.value = false;
  showingDiff.value = false;
  diffContent.value = "";

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
      `/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId}/diff?rev=${event.detail.revision}&format=html`,
    );
    if (!response.ok) throw new Error("Failed to fetch diff");

    diffContent.value = await response.text();
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
            {{ showingDiff ? "Comparing" : "Viewing" }}
            {{ viewingSuggestion ? "Suggestion" : "Revision" }} {{ revisionNumber }}
          </p>
          <p class="my-0! text-size-small text-amber-700 flex items-center gap-3">
            <template v-if="showingDiff">
              Changes from the published version are shown inline.
              <span class="inline-flex items-center gap-2">
                <span class="px-1 rounded-xs bg-green-100 text-green-700 no-underline"
                  >added</span
                >
                <span class="px-1 rounded-xs bg-red-100 text-red-700 line-through"
                  >removed</span
                >
              </span>
            </template>
            <template v-else-if="viewingSuggestion">
              This suggestion is read-only until it is applied.
            </template>
            <template v-else>
              This is a historical version of the document. Changes cannot be made.
            </template>
          </p>
        </div>
      </div>
      <button
        type="button"
        @click="closeRevisionView"
        class="px-4 py-2 text-size-medium font-medium text-amber-900 bg-amber-100 border border-amber-300 rounded-sm hover:bg-amber-200 transition-colors"
      >
        Show published version
      </button>
    </div>

    <!-- App Revision View (diffs render as an inline redline via document-view) -->
    <div v-if="documentType === 'app' && !showingDiff" class="h-full">
      <AppView :html="revisionContent" />
    </div>

    <!-- Document / other type Revision View and inline diff -->
    <div v-else>
      <document-view ref="docViewEl" />
    </div>
  </div>
</template>
