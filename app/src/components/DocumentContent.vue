<script setup>
import { defineAsyncComponent, onMounted, onUnmounted, ref, computed, watch } from "vue";
import ToolbarFormatting from "./ToolbarFormatting.vue";
import ToolbarTable from "./ToolbarTable.vue";
import DiffView from "./DiffView.vue";
import CommentManager from "./CommentManager.vue";
import { useSpace } from "../composeables/useSpace.ts";
import { useSync } from "../composeables/useSync.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import { useQuery } from "@tanstack/vue-query";
import { api } from "../api/client.ts";
import docStyles from "../styles/document.css?inline";

const props = defineProps({
  documentId: {
    type: String,
  },
  initialHtml: {
    type: String,
    default: "",
  },
  spaceId: {
    type: String,
    required: true,
  },
  documentType: {
    type: String,
    default: "document",
  },
  readonly: {
    type: Boolean,
    default: false,
  },
  initialEditMode: {
    type: Boolean,
    default: false,
  },
});

const isEditing = ref(props.initialEditMode);
const isEditingReady = ref(false);
const viewingRevision = ref(false);
const revisionNumber = ref(null);
const revisionContent = ref("");
const sidebarOpen = ref(false);
const showingDiff = ref(false);
const diffPatch = ref("");
const { currentSpaceId } = useSpace();
const pendingReload = ref(false);
const renderedHtml = ref(props.initialHtml || "");
const readViewEl = ref(null);
const editorViewEl = ref(null);
const tableViewEl = ref(null);
const getEditor = () => globalThis.__editor;
const handleVisibilityChange = () => {
  if (pendingReload.value && document.visibilityState === "visible") {
    pendingReload.value = false;
    reloadIfReady();
  }
};

const user = useUserProfile();
const { saveStatus, saveError, saveDocument, cancelDebounce } = useDocument(
  props.documentId,
  props.documentType,
);
const { saveRevision } = useRevisions(props.documentId);

const AppView = defineAsyncComponent(() => import("./AppView.vue"));

function handleEditModeStart() {
  if (!viewingRevision.value && !props.readonly) {
    isEditing.value = true;
  }
}

watch(isEditingReady, (ready) => {
  document.body.dataset.editing = !!isEditingReady.value;
});

async function manualSave() {
  const editor = getEditor();
  if (editor) {
    const content = editor.getHTML();
    await saveRevisionSnapshot();
    await saveDocument(content);
  }
}

async function saveRevisionSnapshot() {
  const editor = getEditor();
  if (editor) {
    const html = editor.getHTML();
    await saveRevision(html, "Manual save");
  }
}

watch([saveStatus, saveError], () => {
  window.dispatchEvent(
    new CustomEvent("save-status-changed", {
      detail: { status: saveStatus.value, error: saveError.value },
    }),
  );
  if (saveStatus.value === "saved" && props.documentType !== "canvas") {
    isEditing.value = false;
  }
});

function initEditor() {
  if (!editorViewEl.value) return;

  window.dispatchEvent(
    new CustomEvent("editor-ready", { detail: { saveFunction: manualSave } }),
  );
  isEditingReady.value = true;
  window.dispatchEvent(new CustomEvent("document:edit"));

  editorViewEl.value.init(props.spaceId, props.documentId, user.value);
}

watch(isEditing, (editing) => {
  if (editing && !viewingRevision.value) {
    // Wait for the v-if to render the document-view element
    requestAnimationFrame(initEditor);
  }
});

function handleRevisionView(event) {
  viewingRevision.value = true;
  document.body.dataset.revision = true;
  revisionNumber.value = event.detail.revision;
  revisionContent.value = event.detail.content;
  isEditing.value = false;
  isEditingReady.value = false;
}

function handleRevisionClose() {
  viewingRevision.value = false;
  document.body.removeAttribute("data-revision");
  revisionNumber.value = null;
  revisionContent.value = "";

  const params = new URLSearchParams(location.search);
  params.delete("revision");

  history.replaceState(
    null,
    "",
    `${location.origin}${location.pathname}${params.toString()}`,
  );
}

function closeRevisionView() {
  showingDiff.value = false;
  handleRevisionClose();
}

function handleSidebarToggle(event) {
  sidebarOpen.value = event.detail.isOpen;
}

async function handleRevisionDiff(event) {
  if (!currentSpaceId.value) return;

  try {
    const response = await fetch(
      `/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId}/diff?rev=${event.detail.revision}`,
    );
    if (!response.ok) throw new Error("Failed to fetch diff");

    diffPatch.value = await response.text();
    showingDiff.value = true;
    viewingRevision.value = true;
    document.body.dataset.revision = true;
    revisionNumber.value = event.detail.revision;
    isEditing.value = false;
    isEditingReady.value = false;
  } catch (error) {
    console.error("Failed to load diff:", error);
  }
}

onMounted(() => {
  if (!props.readonly && props.documentType !== "canvas" && props.documentType !== "app" && props.documentType !== "csv") {
    window.addEventListener("edit-mode-start", handleEditModeStart);
  }

  window.addEventListener("revision:view", handleRevisionView);
  window.addEventListener("revision:close", handleRevisionClose);
  window.addEventListener("revisions:toggled", handleSidebarToggle);
  window.addEventListener("revision:diff", handleRevisionDiff);

  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", handleVisibilityChange);
  }

  renderReadView();

  if (props.documentType === "csv") {
    import("../editor/elements/table-view.ts").then(renderTableView);
  }

  if (props.initialEditMode) {
    requestAnimationFrame(initEditor);
  }
});

onUnmounted(() => {
  window.removeEventListener("edit-mode-start", handleEditModeStart);
  window.removeEventListener("revision:view", handleRevisionView);
  window.removeEventListener("revision:close", handleRevisionClose);
  window.removeEventListener("revisions:toggled", handleSidebarToggle);
  window.removeEventListener("revision:diff", handleRevisionDiff);
  if (typeof window !== "undefined") {
    window.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  cancelDebounce();
});

function reloadIfReady() {
  if (isEditing.value || viewingRevision.value) return;
  if (!props.documentId) return;
  refreshDocument();
}

const { data: documentData, refetch: refreshDocument } = useQuery({
  queryKey: computed(() => ["wiki_document", currentSpaceId.value, props.documentId]),
  queryFn: async () => {
    if (!currentSpaceId.value) {
      throw new Error("No space ID");
    }
    if (!props.documentId) {
      return null;
    }
    return await api.document.get(currentSpaceId.value, props.documentId);
  },
  enabled: computed(() => !!currentSpaceId.value && !!props.documentId),
});

watch(documentData, (doc) => {
  if (doc && typeof doc.content === "string") {
    renderedHtml.value = doc.content;
  }
});

function renderTableView() {
  if (!tableViewEl.value) return;
  tableViewEl.value.setContent(renderedHtml.value);
}

function renderReadView() {
  if (!readViewEl.value) return;
  if (isEditing.value || viewingRevision.value) return;
  if (props.documentType === "canvas" || props.documentType === "app") return;

  const container = readViewEl.value;
  const root = container.shadowRoot;

  if (!root) {
    requestAnimationFrame(renderReadView);
    return;
  }

  root.innerHTML = "";

  const style = document.createElement("style");
  style.textContent = docStyles;

  const content = document.createElement("div");
  content.setAttribute("part", "content");

  const inner = document.createElement("div");
  inner.innerHTML = renderedHtml.value;

  content.appendChild(inner);
  root.appendChild(style);
  root.appendChild(content);
}

watch([renderedHtml, isEditing, viewingRevision], () => {
  renderReadView();
  renderTableView();
});


useSync(
  currentSpaceId,
  () => (props.documentId ? [realtimeTopics.document(props.documentId)] : []),
  (scopes) => {
    if (!props.documentId) return;
    if (!scopes.includes(realtimeTopics.document(props.documentId))) return;

    if (document.visibilityState === "visible") {
      reloadIfReady();
    } else {
      pendingReload.value = true;
    }
  },
);
</script>

<template>
  <div>
    <!-- Floating Text Formatting Menu -->
    <ToolbarFormatting />
    <ToolbarTable />

    <!-- Revision Disclaimer Banner -->
    <div
      v-if="viewingRevision"
      class="sticky top-0 z-60 bg-amber-50 border-b border-amber-200 px-6 py-4 flex items-center justify-between duration-300 mb-10"
      :style="{ marginRight: sidebarOpen ? '432px' : '0' }"
    >
      <div class="flex items-center gap-3">
        <svg class="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="text-sm font-semibold text-amber-900">
            Viewing Revision {{ revisionNumber }}
          </p>
          <p class="my-0! text-xs text-amber-700">
            This is a historical version of the document. Changes cannot be made.
          </p>
        </div>
      </div>
      <button
        @click="closeRevisionView"
        class="px-4 py-2 text-sm font-medium text-amber-900 bg-amber-100 border border-amber-300 rounded hover:bg-amber-200 transition-colors"
      >
        Show published version
      </button>
    </div>

    <!-- Revision View with Diff -->
    <div v-if="viewingRevision && showingDiff">
      <div>
        <DiffView
          :patch="diffPatch"
        />
      </div>
    </div>

    <!-- Revision View -->
    <div v-if="viewingRevision && !showingDiff && props.documentType !== 'app'">
      <document-view>
        <template v-html="revisionContent"></template>
      </document-view>
    </div>

    <!-- Read View -->
    <div v-if="!isEditing && !viewingRevision && props.documentType !== 'canvas' && props.documentType !== 'app' && props.documentType !== 'csv'">
      <document-view ref="readViewEl"></document-view>
    </div>

    <!-- App View -->
    <div v-if="props.documentType === 'app' && !viewingRevision" class="h-full">
      <AppView :html="renderedHtml" />
    </div>

    <!-- App Revision View -->
    <div v-if="props.documentType === 'app' && viewingRevision && !showingDiff" class="h-full">
      <AppView :html="revisionContent" />
    </div>
  </div>

  <!-- CSV Spreadsheet View — fragment root so it inherits height from the flex parent directly -->
  <table-view
    v-if="!isEditing && !viewingRevision && props.documentType === 'csv'"
    ref="tableViewEl"
    class="block flex-1 min-h-0"
  ></table-view>

  <!-- Editor -->
  <div v-if="isEditing && !viewingRevision && !props.readonly" :class="['h-full', !isEditingReady && 'opacity-0']">
    <document-view ref="editorViewEl"></document-view>
  </div>
  
  <document-statusbar class="block sticky left-0 bottom-0 pb-6 pt-20 bg-linear-to-b from-transparent to-neutral-10 pointer-events-none"></document-statusbar>

  <CommentManager
    v-if="props.documentId && props.documentType !== 'canvas' && props.documentType !== 'app' && props.documentType !== 'csv'"
    :spaceId="props.spaceId"
    :documentId="props.documentId"
    :currentRev="documentData?.currentRev"
  />
</template>
