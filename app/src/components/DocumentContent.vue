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

import { api } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { useSync } from "../composeables/useSync.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import { useYjsDocumentRoom } from "../composeables/useYjsDocumentRoom.ts";
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
import { joinPresenceRoom } from "../utils/sync.ts";
import Canvas from "./Canvas.vue";
import CommentManager from "./CommentManager.vue";
import "../editor/elements/toolbar.ts";
import "../components/document-statusbar.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "../utils/formattingActions.ts";

const props = withDefaults(
  defineProps<{
    documentId?: string;
    initialHtml?: string;
    documentType?: string;
    readonly?: boolean;
    spaceId: string;
    initialEditMode?: boolean;
  }>(),
  {
    initialHtml: "",
    documentType: "document",
    readonly: false,
    initialEditMode: false,
  },
);

const documentId = computed(() => props.documentId);
const documentType = computed(() => props.documentType || "document");
const documentReadonly = computed(() => props.readonly);

const isEditing = ref(props.initialEditMode);
const isEditingReady = ref(false);
const shouldMountEditor = ref(false);
const { currentSpaceId } = useSpace();
const pendingReload = ref(false);
const renderedHtml = ref(props.initialHtml || "");
type DocumentViewElement = HTMLElement & {
  collaborationDocument?: Y.Doc;
  destroyEditor?: () => void;
  renderReadHtml?: (html: string) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};
const documentViewEl = ref<DocumentViewElement | null>(null);
const elementReady = ref(false);
const tableViewEl = ref(null);
const isMounted = ref(false);
const getEditor = () => globalThis.__editor;
type DocumentToolbarElement = HTMLElement & {
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};
let leaveEditorPresence: (() => void) | null = null;
let editorPresenceTimer: ReturnType<typeof setInterval> | null = null;
let editorActionsRegistered = false;
let leaveEditorActionSubscriptions: Array<() => void> = [];
let editorPresenceHandle: {
  update: (state: DocumentPresenceState) => void;
  leave: () => void;
} | null = null;
let pendingEditorCreatedResolve: ((ready: boolean) => void) | null = null;
let pendingEditorCreatedTimer: ReturnType<typeof setTimeout> | null = null;
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
  documentId.value,
  documentType.value,
);
const { revisions, saveRevision, fetchHistory } = useRevisions(documentId.value);
const suggestionPatches = ref<Record<number, string>>({});
const editorRoom = useYjsDocumentRoom(props.spaceId, documentId.value);
const editorYdoc = editorRoom.ydoc;

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
  if (!documentReadonly.value) {
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
  if (saveStatus.value === "saved" && documentType.value !== "canvas") {
    isEditing.value = false;
  }
});

async function setupEditorBridge() {
  await editorRoom.joinUntilReady();
  shouldMountEditor.value = true;
  await nextTick();
  if (!(await waitForEditorMounted())) return;
  await setupEditorPresence();
  registerEditorActions();
  window.dispatchEvent(
    new CustomEvent("editor-ready", { detail: { saveFunction: manualSave } }),
  );
  isEditingReady.value = true;
  window.dispatchEvent(new CustomEvent("document:edit"));
}

function waitForEditorMounted(): Promise<boolean> {
  return new Promise((resolve) => {
    if (getEditor()) {
      resolve(true);
      return;
    }

    pendingEditorCreatedResolve = resolve;
    pendingEditorCreatedTimer = setTimeout(() => {
      pendingEditorCreatedResolve = null;
      pendingEditorCreatedTimer = null;
      resolve(false);
    }, 1000);
  });
}

function handleEditorCreated() {
  if (pendingEditorCreatedTimer) {
    clearTimeout(pendingEditorCreatedTimer);
    pendingEditorCreatedTimer = null;
  }
  pendingEditorCreatedResolve?.(true);
  pendingEditorCreatedResolve = null;
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
  if (!documentId.value || !user.value || editorPresenceHandle) return;

  editorPresenceHandle = joinPresenceRoom<DocumentPresenceState>(
    props.spaceId,
    documentId.value,
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
  if (!currentSpaceId.value || !documentId.value) {
    return;
  }

  await fetchHistory();

  const patches = await Promise.all(
    openSuggestions.value.map(async (suggestion) => {
      const response = await fetch(
        `/api/v1/spaces/${currentSpaceId.value}/documents/${documentId.value}/diff?rev=${suggestion.rev}`,
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
    `Index: ${file.index || documentId.value || "document"}`,
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
    shouldMountEditor.value = false;
    documentViewEl.value?.destroyEditor();
    editorRoom.leave();
  }

  if (editing) {
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
    if (!editing || !documentId.value) {
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

onMounted(() => {
  isMounted.value = true;

  if (
    documentType.value !== "canvas" &&
    documentType.value !== "app" &&
    documentType.value !== "csv"
  ) {
    void customElements.whenDefined("document-view").then(async () => {
      await nextTick();
      assignYdoc();
      elementReady.value = true;
      await nextTick();
      renderDocumentViewHtml();
    });
  }

  if (
    !documentReadonly.value &&
    documentType.value !== "canvas" &&
    documentType.value !== "app" &&
    documentType.value !== "csv"
  ) {
    window.addEventListener("edit-mode-start", handleEditModeStart);
  }
  window.addEventListener("edit-mode-cancel", handleEditModeCancel);
  window.addEventListener("request-editor-ready", () => {
    if (isEditingReady.value) {
      window.dispatchEvent(
        new CustomEvent("editor-ready", { detail: { saveFunction: manualSave } }),
      );
    }
  });
  window.addEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );

  window.addEventListener("document-published", reloadIfReady);

  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", handleVisibilityChange);
  }

  if (documentType.value === "csv") {
    import("../editor/elements/table-view.ts").then(renderTableView);
  }

  if (props.initialEditMode) {
    requestAnimationFrame(setupEditorBridge);
  }
});

onUnmounted(() => {
  unregisterEditorActions();
  editorRoom.leave();
  clearEditorPresence();
  window.removeEventListener("edit-mode-start", handleEditModeStart);
  window.removeEventListener("edit-mode-cancel", handleEditModeCancel);
  window.removeEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );
  window.removeEventListener("document-published", reloadIfReady);
  if (typeof window !== "undefined") {
    window.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  cancelDebounce();
});

function reloadIfReady() {
  if (isEditing.value) return;
  if (!documentId.value) return;
  refreshDocument();
}

const { data: documentData, refetch: refreshDocument } = useQuery({
  queryKey: computed(() => ["wiki_document", currentSpaceId.value, documentId.value]),
  queryFn: async () => {
    if (!currentSpaceId.value) {
      throw new Error("No space ID");
    }
    if (!documentId.value) {
      return null;
    }
    return await api.document.get(currentSpaceId.value, documentId.value);
  },
  enabled: computed(() => !!currentSpaceId.value && !!documentId.value),
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
      (documentType.value === "csv" ||
      documentType.value === "canvas"
        ? "full"
        : "document"),
  );
});

function renderTableView() {
  if (!tableViewEl.value) return;
  tableViewEl.value.setContent(renderedHtml.value);
}

watch([renderedHtml, isEditing, documentViewEl], () => {
  renderTableView();
});

function escapeRawTextElement(value: string) {
  return value.replace(/<\/(script|style)/gi, "<\\/$1");
}

const ssrDeclarativeShadowDom = computed(() => {
  if (!import.meta.env.SSR) return "";
  return [
    '<template shadowrootmode="open">',
    `<style data-document-styles>${escapeRawTextElement(docStyles)}</style>`,
    '<div part="content"><div>',
    renderedHtml.value,
    "</div></div>",
    "</template>",
  ].join("");
});

function assignYdoc() {
  if (documentViewEl.value) {
    documentViewEl.value.collaborationDocument = editorYdoc.value;
  }
}

function renderDocumentViewHtml() {
  if (shouldMountEditor.value || !elementReady.value) return;
  documentViewEl.value?.renderReadHtml?.(renderedHtml.value);
}

watch([renderedHtml, shouldMountEditor, elementReady], () => {
  void nextTick(renderDocumentViewHtml);
});

watch(editorYdoc, () => {
  if (elementReady.value) assignYdoc();
});

useSync(
  currentSpaceId,
  () => (documentId.value ? [realtimeTopics.document(documentId.value)] : []),
  (scopes) => {
    if (!documentId.value) return;
    if (!scopes.includes(realtimeTopics.document(documentId.value))) return;

    if (document.visibilityState === "visible") {
      reloadIfReady();
    } else {
      pendingReload.value = true;
    }
  },
);
</script>

<template>
    <main class="relative">
        <!-- CSV Spreadsheet View -->
        <table-view v-if="!isEditing && documentType === 'csv'" ref="tableViewEl"
            class="block flex-1 min-h-0"></table-view>
            
        <!-- Document View (read + edit, single persistent instance) -->
        <div v-if="documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
            :class="isEditing ? 'h-full' : ''">
            <document-view
                ref="documentViewEl"
                :editor="shouldMountEditor && !documentReadonly && elementReady ? '' : undefined"
                :space-id="props.spaceId"
                :document-id="documentId"
                @editor-created="handleEditorCreated"
                v-html="ssrDeclarativeShadowDom"
            />
        </div>

        <div v-if="isMounted && documentType === 'canvas'" class="h-screen">
            <Canvas :documentId="documentId" :spaceId="props.spaceId" />
        </div>

        <div><!-- DON'T REMOVE; This fixes shadowDOM content not visible in print preview --></div>
    </main>

    <document-toolbar :data-comments-enabled="supportsComments(documentType) ? '' : undefined"></document-toolbar>

    <CommentManager v-if="documentId && supportsComments(documentType)" :spaceId="props.spaceId"
        :documentId="documentId" :currentRev="documentData?.currentRev" />

    <document-statusbar
        v-if="isEditing && !documentReadonly && documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
        class="block sticky left-0 bottom-0 pb-6 pt-20 bg-linear-to-b from-transparent to-neutral-10 pointer-events-none"></document-statusbar>
</template>
