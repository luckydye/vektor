<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import type * as Y from "yjs";
import { api } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useEditorPresence } from "../composeables/useEditorPresence.ts";
import { useInlineSuggestions } from "../composeables/useInlineSuggestions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { useSync } from "../composeables/useSync.ts";
import { useYjsDocumentRoom } from "../composeables/useYjsDocumentRoom.ts";
import type { DocumentPresenceProfile } from "../editor/collaboration.ts";
import docStyles from "../styles/document.css?inline";
import { Actions } from "../utils/actions.ts";
import { supportsComments } from "../utils/documentTypes.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import Canvas from "./Canvas.vue";
import CommentBubble from "./CommentBubble.vue";
import CommentOverlays from "./CommentOverlays.vue";
import "../editor/elements/table-view.ts";
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
const isMounted = ref(false);
const commentBubble = ref<InstanceType<typeof CommentBubble> | null>(null);
const getEditor = () => globalThis.__editor;
type DocumentToolbarElement = HTMLElement & {
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};
let editorActionsRegistered = false;
let leaveEditorActionSubscriptions: Array<() => void> = [];
const handleVisibilityChange = () => {
  if (pendingReload.value && document.visibilityState === "visible") {
    pendingReload.value = false;
    reloadIfReady();
  }
};

const { saveStatus, saveError, saveDocument, cancelDebounce } = useDocument(
  documentId.value,
  documentType.value,
);
const editorRoom = useYjsDocumentRoom(props.spaceId, documentId.value);
const editorYdoc = editorRoom.ydoc;
const { setupEditorPresence, clearEditorPresence } = useEditorPresence({
  spaceId: props.spaceId,
  documentId,
  documentViewEl,
  getEditor,
  isActive: isEditingReady,
});
const { saveRevision, handleInlineSuggestionAccept } = useInlineSuggestions({
  spaceId: currentSpaceId,
  documentId,
  isEditing,
  isEditingReady,
  getEditor,
});

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

  reloadIfReady();
}

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
  // editor-created on <document-view> fires onEditorCreated when Tiptap is ready
}

async function onEditorCreated() {
  if (!isEditing.value) return;
  await setupEditorPresence();
  registerEditorActions();
  window.dispatchEvent(
    new CustomEvent("editor-ready", { detail: { saveFunction: manualSave } }),
  );
  isEditingReady.value = true;
  window.dispatchEvent(new CustomEvent("document:edit"));
}

watch(isEditing, (editing) => {
  if (!editing) {
    unregisterEditorActions();
    clearEditorPresence();
    shouldMountEditor.value = false;
    editorRoom.leave();
  }

  if (editing) {
    requestAnimationFrame(setupEditorBridge);
  }
});

onMounted(() => {
  isMounted.value = true;

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

  window.addEventListener("visibilitychange", handleVisibilityChange);

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
  window.removeEventListener("visibilitychange", handleVisibilityChange);
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

watch(documentData, (doc) => {
  if (!doc) return;
  if (typeof doc.content === "string") {
    renderedHtml.value = doc.content;
  }
  const full =
    doc.properties?.layout === "full" ||
    (!doc.properties?.layout &&
      (documentType.value === "csv" || documentType.value === "canvas"));
  const container = document.querySelector<HTMLElement>("[data-layout]");
  container?.classList.toggle("max-w-full", full);
  container?.classList.toggle("max-w-(--document-width)", !full);
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

// Set elementReady when the document-view element first mounts into the DOM
watch(documentViewEl, async (el) => {
  if (!el) return;
  await customElements.whenDefined("document-view");
  elementReady.value = true;
}, { flush: "post" });

watch([editorYdoc, documentViewEl], () => {
  if (documentViewEl.value) {
    documentViewEl.value.collaborationDocument = editorYdoc.value;
  }
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
        <table-view v-if="!isEditing && documentType === 'csv'"
            :html="renderedHtml" class="block flex-1 min-h-0"></table-view>

        <!-- Document View (read + edit, single persistent instance) -->
        <div v-if="documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
            :class="isEditing ? 'h-full' : ''">
            <document-view ref="documentViewEl"
                :editor="shouldMountEditor && !documentReadonly && elementReady ? '' : undefined"
                :html="renderedHtml"
                :space-id="props.spaceId" :document-id="documentId" @editor-created="onEditorCreated"
                v-html="ssrDeclarativeShadowDom" />
        </div>

        <div v-if="isMounted && documentType === 'canvas'" class="h-screen">
            <Canvas :documentId="documentId" :spaceId="props.spaceId" />
        </div>

        <div><!-- DON'T REMOVE; This fixes shadowDOM content not visible in print preview --></div>
    </main>

    <template v-if="documentId && supportsComments(documentType)">
        <CommentBubble ref="commentBubble" :spaceId="props.spaceId" :documentId="documentId"
            :currentRev="documentData?.currentRev" />
        <CommentOverlays :comments="commentBubble?.commentsForOverlays ?? []"
            @move="commentBubble?.handleMoveThread($event)" />
    </template>

    <document-statusbar
        v-if="isEditing && !documentReadonly && documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
        class="block sticky left-0 bottom-0 pb-6 pt-20 bg-linear-to-b from-transparent to-neutral-10 pointer-events-none"></document-statusbar>
        
    <document-toolbar :data-comments-enabled="supportsComments(documentType) ? '' : undefined"></document-toolbar>
</template>
