<script setup lang="ts">
import { applyPatch, parsePatch } from "diff";
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import { absolutePositionToRelativePosition } from "y-prosemirror";
import * as Y from "yjs";
import { clockIcon } from "~/src/assets/icons.ts";
import { api } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { useSync } from "../composeables/useSync.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import {
  type DocumentPresenceProfile,
  findYSyncState,
  getPresenceColor,
} from "../editor/collaboration.ts";
import docStyles from "../styles/document.css?inline";
import { Actions } from "../utils/actions.ts";
import { supportsComments } from "../utils/documentTypes.ts";
import { prettyPrintHtml } from "../utils/prettyHtml.ts";
import { type PresenceEnvelope, realtimeTopics } from "../utils/realtime.ts";
import { joinPresenceRoom, joinYjsRoom } from "../utils/sync.ts";
import Canvas from "./Canvas.vue";
import CommentManager from "./CommentManager.vue";
import DiffView from "./DiffView.vue";
import WorkflowView from "./WorkflowView.vue";
import "../editor/elements/toolbar.ts";
import "../elements/document-statusbar.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "../utils/formattingActions.ts";

const props = defineProps({
  documentId: {
    type: String,
  },
  initialHtml: {
    type: String,
    default: "",
  },
  initialLayout: {
    type: String,
    default: "document",
  },
  spaceId: {
    type: String,
    required: true,
  },
  spaceSlug: {
    type: String,
    default: "",
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
const revisionNumber = ref<number | null>(null);
const revisionContent = ref("");
const viewingSuggestion = ref(false);
const sidebarOpen = ref(false);
const showingDiff = ref(false);
const diffPatch = ref("");
const { currentSpaceId } = useSpace();
const pendingReload = ref(false);
const renderedHtml = ref(props.initialHtml || "");
type DocumentViewElement = HTMLElement & {
  collaborationDocument?: Y.Doc;
  destroyEditor?: () => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};
const documentViewEl = ref<DocumentViewElement | null>(null);
const tableViewEl = ref(null);
const isMounted = ref(false);
const getEditor = () => globalThis.__editor;
type DocumentToolbarElement = HTMLElement & {
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};
let leaveEditorCollaboration: (() => void) | null = null;
let leaveEditorPresence: (() => void) | null = null;
let editorPresenceTimer: ReturnType<typeof setInterval> | null = null;
let editorActionsRegistered = false;
let leaveEditorActionSubscriptions: Array<() => void> = [];
let editorPresenceHandle: {
  update: (state: DocumentPresenceState) => void;
  leave: () => void;
} | null = null;
let lastEditorPresenceState = "";
const editorPresenceClientId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `editor:${Date.now()}:${Math.random().toString(36).slice(2)}`;
const remoteEditorPresences = new Map<string, PresenceEnvelope<DocumentPresenceState>>();
const handleVisibilityChange = () => {
  if (pendingReload.value && document.visibilityState === "visible") {
    pendingReload.value = false;
    reloadIfReady();
  }
};

type DocumentPresenceState = NonNullable<DocumentPresenceProfile["state"]>;

const user = useUserProfile();
const { saveStatus, saveError, saveDocument, cancelDebounce } = useDocument(
  props.documentId,
  props.documentType,
);
const { revisions, saveRevision, fetchHistory } = useRevisions(props.documentId);
const suggestionPatches = ref<Record<number, string>>({});

const AppView = defineAsyncComponent(() => import("./AppView.vue"));

function getDocumentToolbar() {
  return document.querySelector<DocumentToolbarElement>("document-toolbar");
}

function registerEditorActions() {
  if (editorActionsRegistered) return;

  registerFormattingActions();
  Actions.register("toolbar:dismiss", {
    title: "Dismiss toolbar",
    description: "Hide the editor toolbar",
    group: "formatting",
    run: async () => {
      getDocumentToolbar()?.dismiss?.();
    },
  });
  Actions.mapShortcut("escape", "toolbar:dismiss");

  leaveEditorActionSubscriptions = [
    Actions.subscribe("format:color:text:open", () => {
      getDocumentToolbar()?.openTextColorPicker?.();
    }),
    Actions.subscribe("format:color:background:open", () => {
      getDocumentToolbar()?.openBackgroundColorPicker?.();
    }),
  ];
  editorActionsRegistered = true;
}

function unregisterEditorActions() {
  if (!editorActionsRegistered) return;

  unregisterFormattingActions();
  Actions.unmapShortcut("escape", "toolbar:dismiss");
  Actions.unregister("toolbar:dismiss");
  for (const leave of leaveEditorActionSubscriptions) {
    leave();
  }
  leaveEditorActionSubscriptions = [];
  editorActionsRegistered = false;
}

function handleEditModeStart() {
  if (!viewingRevision.value && !props.readonly) {
    isEditing.value = true;
  }
}

async function handleEditModeCancel() {
  cancelDebounce();
  unregisterEditorActions();
  isEditingReady.value = false;
  isEditing.value = false;

  if (typeof documentData.value?.content === "string") {
    renderedHtml.value = documentData.value.content;
  }

  await nextTick();
  renderReadView();
  await reloadIfReady();
}

watch(isEditingReady, (_ready) => {
  document.body.dataset.editing = !!isEditingReady.value;
});

async function manualSave(mode: "revision" | "suggestion" = "revision") {
  const editor = getEditor();
  if (editor) {
    const content = editor.getHTML();
    if (mode === "suggestion") {
      await saveRevision(content, "Suggested changes", "suggestion");
      isEditingReady.value = false;
      isEditing.value = false;
      await refreshDocument();
      return;
    }
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

async function setupEditorBridge() {
  if (!(await setupEditorCollaboration())) return;
  await setupEditorPresence();
  registerEditorActions();
  window.dispatchEvent(
    new CustomEvent("editor-ready", { detail: { saveFunction: manualSave } }),
  );
  isEditingReady.value = true;
  window.dispatchEvent(new CustomEvent("document:edit"));
}

async function setupEditorCollaboration(): Promise<boolean> {
  if (!props.documentId || leaveEditorCollaboration) return true;

  await customElements.whenDefined("document-view");
  await nextTick();

  const ydoc = documentViewEl.value?.collaborationDocument;
  if (!(ydoc instanceof Y.Doc)) {
    return false;
  }

  leaveEditorCollaboration = joinYjsRoom(props.spaceId, props.documentId, ydoc);
  return true;
}

function editorPresenceState(): DocumentPresenceState {
  const editor = getEditor();
  const view = documentViewEl.value;
  if (!editor || !view) {
    return { kind: "editor", focused: false, selection: null };
  }

  const focused = editor.isFocused || editor.view.hasFocus();
  if (!focused) {
    return { kind: "editor", focused: false, selection: null };
  }

  const syncState = findYSyncState(editor);
  const mapping = syncState?.binding?.mapping;
  if (!mapping) {
    return { kind: "editor", focused: false, selection: null };
  }

  try {
    const { anchor, head } = editor.state.selection;
    return {
      kind: "editor",
      focused,
      selection: {
        anchor: Y.relativePositionToJSON(
          absolutePositionToRelativePosition(anchor, syncState.type, mapping),
        ),
        head: Y.relativePositionToJSON(
          absolutePositionToRelativePosition(head, syncState.type, mapping),
        ),
      },
    };
  } catch {
    return { kind: "editor", focused: false, selection: null };
  }
}

function renderEditorPresence() {
  documentViewEl.value?.setPresenceProfiles(
    [...remoteEditorPresences.values()].map((presence) => ({
      clientId: presence.clientId,
      user: presence.user,
      state: presence.state,
    })),
  );
}

function updateEditorPresence() {
  if (!editorPresenceHandle) return;

  const state = editorPresenceState();
  const serialized = JSON.stringify(state);
  if (serialized === lastEditorPresenceState) return;

  lastEditorPresenceState = serialized;
  editorPresenceHandle.update(state);
}

function clearEditorPresence() {
  if (editorPresenceTimer) {
    clearInterval(editorPresenceTimer);
    editorPresenceTimer = null;
  }
  leaveEditorPresence?.();
  leaveEditorPresence = null;
  editorPresenceHandle = null;
  lastEditorPresenceState = "";
  remoteEditorPresences.clear();
  renderEditorPresence();
}

async function setupEditorPresence() {
  if (!props.documentId || !user.value || editorPresenceHandle) return;

  if (!props.documentId || !user.value || editorPresenceHandle) return;

  editorPresenceHandle = joinPresenceRoom<DocumentPresenceState>(
    props.spaceId,
    props.documentId,
    editorPresenceClientId,
    {
      id: user.value.id,
      name: user.value.name,
      image: user.value.image,
      color: getPresenceColor(user.value.id),
    },
    (event) => {
      if (event.type === "presence-snapshot") {
        remoteEditorPresences.clear();
        for (const presence of event.presences) {
          if (presence.clientId !== editorPresenceClientId) {
            remoteEditorPresences.set(presence.clientId, presence);
          }
        }
      } else if (event.type === "presence-update") {
        if (event.presence.clientId !== editorPresenceClientId) {
          remoteEditorPresences.set(event.presence.clientId, event.presence);
        }
      } else {
        remoteEditorPresences.delete(event.clientId);
      }

      renderEditorPresence();
    },
    editorPresenceState(),
  );
  leaveEditorPresence = editorPresenceHandle.leave;
  lastEditorPresenceState = JSON.stringify(editorPresenceState());
  editorPresenceTimer = setInterval(updateEditorPresence, 120);
}

function syncInlineSuggestions() {
  const editor = getEditor();
  if (!editor?.commands) {
    return;
  }

  editor.commands.setInlineSuggestions(
    openSuggestions.value
      .filter((suggestion) => suggestionPatches.value[suggestion.rev])
      .map((suggestion) => ({
        rev: suggestion.rev,
        message: suggestion.message,
        patch: suggestionPatches.value[suggestion.rev],
      })),
  );
}

const openSuggestions = computed(() => {
  return revisions.value.filter((revision) => revision.status === "open");
});

async function loadSuggestionPatches() {
  if (!currentSpaceId.value || !props.documentId) {
    return;
  }

  await fetchHistory();

  const patches = await Promise.all(
    openSuggestions.value.map(async (suggestion) => {
      const response = await fetch(
        `/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId}/diff?rev=${suggestion.rev}`,
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch diff for suggestion ${suggestion.rev}`);
      }

      return [suggestion.rev, await response.text()] as const;
    }),
  );

  suggestionPatches.value = Object.fromEntries(patches);
}

function buildSingleHunkPatch(patch: string, hunkIndex: number): string {
  const parsed = parsePatch(patch);
  const file = parsed[0];
  if (!file) {
    throw new Error("Patch is empty");
  }

  const hunk = file.hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Hunk ${hunkIndex} not found`);
  }

  const oldHeader = file.oldHeader ? `\t${file.oldHeader}` : "";
  const newHeader = file.newHeader ? `\t${file.newHeader}` : "";

  return [
    `Index: ${file.index || props.documentId || "document"}`,
    "===================================================================",
    `--- ${file.oldFileName}${oldHeader}`,
    `+++ ${file.newFileName}${newHeader}`,
    hunk.content,
    ...hunk.lines,
    "",
  ].join("\n");
}

function setEditorHtml(html: string) {
  const editor = getEditor();
  if (!editor) {
    throw new Error("Editor is not ready");
  }

  editor.commands.setContent(html);
}

function acceptSuggestionHunk(revisionRev: number, hunkIndex: number) {
  const patch = suggestionPatches.value[revisionRev];
  if (!patch) {
    throw new Error(`Suggestion patch ${revisionRev} not loaded`);
  }

  const editor = getEditor();
  if (!editor) {
    throw new Error("Editor is not ready");
  }

  const currentHtml = prettyPrintHtml(editor.getHTML());
  const nextHtml = applyPatch(currentHtml, buildSingleHunkPatch(patch, hunkIndex));
  if (nextHtml === false) {
    throw new Error(
      `Failed to apply suggestion hunk ${hunkIndex + 1} from suggestion ${revisionRev}`,
    );
  }

  setEditorHtml(nextHtml);
}

function handleInlineSuggestionAccept(
  event: CustomEvent<{ revisionRev: number; hunkIndex: number }>,
) {
  acceptSuggestionHunk(event.detail.revisionRev, event.detail.hunkIndex);
}

watch(isEditing, (editing) => {
  if (!editing) {
    unregisterEditorActions();
    clearEditorPresence();
    documentViewEl.value?.destroyEditor();
    nextTick(renderReadView);
  }

  if (editing && !viewingRevision.value) {
    requestAnimationFrame(setupEditorBridge);
  }
});

watch(user, () => {
  if (isEditing.value && isEditingReady.value) {
    void setupEditorPresence();
  }
});

watch(
  isEditing,
  async (editing) => {
    if (!editing || !props.documentId) {
      suggestionPatches.value = {};
      getEditor()?.commands.clearInlineSuggestions();
      return;
    }

    await loadSuggestionPatches();
  },
  { immediate: true },
);

watch(
  [suggestionPatches, isEditingReady],
  () => {
    if (!isEditingReady.value) {
      return;
    }

    syncInlineSuggestions();
  },
  { deep: true },
);

function handleRevisionView(event) {
  viewingRevision.value = true;
  document.body.dataset.revision = true;
  revisionNumber.value = event.detail.revision;
  revisionContent.value = event.detail.content;
  viewingSuggestion.value = Boolean(event.detail.isSuggestion);
  isEditing.value = false;
  isEditingReady.value = false;
}

function handleRevisionClose() {
  viewingRevision.value = false;
  document.body.removeAttribute("data-revision");
  revisionNumber.value = null;
  revisionContent.value = "";
  viewingSuggestion.value = false;

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
    viewingSuggestion.value = Boolean(event.detail.isSuggestion);
    isEditing.value = false;
    isEditingReady.value = false;
  } catch (error) {
    console.error("Failed to load diff:", error);
  }
}

onMounted(() => {
  isMounted.value = true;

  if (
    !props.readonly &&
    props.documentType !== "canvas" &&
    props.documentType !== "app" &&
    props.documentType !== "csv"
  ) {
    window.addEventListener("edit-mode-start", handleEditModeStart);
  }
  window.addEventListener("edit-mode-cancel", handleEditModeCancel);
  window.addEventListener("request-editor-ready", () => {
    if (isEditingReady.value) {
      window.dispatchEvent(new CustomEvent("editor-ready", { detail: { saveFunction: manualSave } }));
    }
  });
  window.addEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );

  window.addEventListener("revision:view", handleRevisionView);
  window.addEventListener("revision:close", handleRevisionClose);
  window.addEventListener("revisions:toggled", handleSidebarToggle);
  window.addEventListener("revision:diff", handleRevisionDiff);
  window.addEventListener("document-published", reloadIfReady);

  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", handleVisibilityChange);
  }

  applyLayout(props.initialLayout);
  renderReadView();

  if (props.documentType === "csv") {
    import("../editor/elements/table-view.ts").then(renderTableView);
  }

  // Pre-warm the ydoc so it's populated before the editor starts on first edit.
  // Keeping the room open in read mode is fine — it stays current with remote changes.
  void setupEditorCollaboration();

  if (props.initialEditMode) {
    requestAnimationFrame(setupEditorBridge);
  }
});

onUnmounted(() => {
  unregisterEditorActions();
  leaveEditorCollaboration?.();
  clearEditorPresence();
  window.removeEventListener("edit-mode-start", handleEditModeStart);
  window.removeEventListener("edit-mode-cancel", handleEditModeCancel);
  window.removeEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );
  window.removeEventListener("revision:view", handleRevisionView);
  window.removeEventListener("revision:close", handleRevisionClose);
  window.removeEventListener("revisions:toggled", handleSidebarToggle);
  window.removeEventListener("revision:diff", handleRevisionDiff);
  window.removeEventListener("document-published", reloadIfReady);
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

function applyLayout(layoutMode: string) {
  const container = document.querySelector("[data-layout]") as HTMLElement | null;
  if (!container) return;
  container.setAttribute("data-layout", layoutMode);
  if (layoutMode === "full") {
    container.classList.remove("max-w-(--document-width)");
    container.classList.add("max-w-full");
  } else {
    container.classList.remove("max-w-full");
    container.classList.add("max-w-(--document-width)");
  }
}

watch(documentData, (doc) => {
  if (!doc) return;
  if (typeof doc.content === "string") {
    renderedHtml.value = doc.content;
  }
  applyLayout(
    doc.properties?.layout ||
      (props.documentType === "csv" ||
      props.documentType === "canvas" ||
      props.documentType === "workflow"
        ? "full"
        : "document"),
  );
});

function renderTableView() {
  if (!tableViewEl.value) return;
  tableViewEl.value.setContent(renderedHtml.value);
}

function renderReadView() {
  if (!documentViewEl.value) return;
  if (isEditing.value || viewingRevision.value) return;
  if (
    props.documentType === "canvas" ||
    props.documentType === "app" ||
    props.documentType === "workflow"
  )
    return;

  const container = documentViewEl.value;
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

watch([renderedHtml, isEditing, viewingRevision, documentViewEl], () => {
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
        <!-- Revision Disclaimer Banner -->
        <div v-if="viewingRevision"
            class="sticky top-0 z-60 bg-amber-50 border-b border-amber-200 px-6 py-4 flex items-center justify-between duration-300 mb-10"
            :style="{ marginRight: sidebarOpen ? '432px' : '0' }">
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
            <button @click="closeRevisionView"
                class="px-4 py-2 text-size-medium font-medium text-amber-900 bg-amber-100 border border-amber-300 rounded-sm hover:bg-amber-200 transition-colors">
                Show published version
            </button>
        </div>

        <!-- Revision View with Diff -->
        <div v-if="viewingRevision && showingDiff">
            <div>
                <DiffView :patch="diffPatch" />
            </div>
        </div>

        <!-- Revision View -->
        <div v-if="viewingRevision && !showingDiff && props.documentType !== 'app'">
            <document-view>
                <template v-html="revisionContent"></template>
            </document-view>
        </div>

    </div>

    <main class="relative">
        <!-- CSV Spreadsheet View -->
        <table-view v-if="!isEditing && !viewingRevision && props.documentType === 'csv'" ref="tableViewEl"
            class="block flex-1 min-h-0"></table-view>
        <!-- App View -->
        <div v-if="props.documentType === 'app' && !viewingRevision" class="h-full">
            <AppView :html="renderedHtml" />
        </div>

        <!-- App Revision View -->
        <div v-if="props.documentType === 'app' && viewingRevision && !showingDiff" class="h-full">
            <AppView :html="revisionContent" />
        </div>

        <!-- Document View (read + edit, single persistent instance) -->
        <div v-if="!viewingRevision && props.documentType !== 'canvas' && props.documentType !== 'app' && props.documentType !== 'csv'"
            :class="isEditing ? 'h-full' : ''">
            <document-view ref="documentViewEl" v-bind="isEditing && !props.readonly ? { editor: '' } : {}"
                :space-id="props.spaceId" :document-id="props.documentId"
                :editor-context.prop="isEditing && !props.readonly ? { spaceId: props.spaceId, documentId: props.documentId } : undefined">
                <template v-html="renderedHtml"></template>
            </document-view>
        </div>

        <div v-if="isMounted && props.documentType === 'canvas'" class="h-screen">
            <Canvas :documentId="props.documentId" :spaceId="props.spaceId" />
        </div>

        <WorkflowView v-else-if="isMounted && props.documentType === 'workflow' && props.documentId"
            :documentId="props.documentId" :spaceId="props.spaceId" :spaceSlug="props.spaceSlug" />

        <div><!-- DON'T REMOVE; This fixes shadowDOM content not visible in print preview --></div>
    </main>

    <document-toolbar></document-toolbar>

    <CommentManager v-if="props.documentId && supportsComments(props.documentType)" :spaceId="props.spaceId"
        :documentId="props.documentId" :currentRev="documentData?.currentRev" />

    <document-statusbar
        v-if="isEditing && !viewingRevision && !props.readonly && props.documentType !== 'canvas' && props.documentType !== 'app' && props.documentType !== 'csv'"
        class="block sticky left-0 bottom-0 pb-6 pt-20 bg-linear-to-b from-transparent to-neutral-10 pointer-events-none"></document-statusbar>
</template>
