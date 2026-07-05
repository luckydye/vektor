<script setup lang="ts">
import type { Editor } from "@tiptap/core";
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { getRelativeSelection } from "y-prosemirror";
import * as Y from "yjs";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import {
  type CollaborationPresenceProfile,
  provideCollaboration,
  useCollaboration,
} from "#composeables/useCollaboration.ts";
import { resetEditingState, useEditor } from "#composeables/useEditor.ts";
import { useInlineSuggestions } from "#composeables/useInlineSuggestions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { setActiveEditor } from "#editor/activeEditor.ts";
import {
  type CanvasPresenceState,
  type DocumentPresenceProfile,
  type DocumentPresenceState,
  findYSyncState,
} from "#editor/collaboration.ts";
import docStyles from "#styles/document.css?inline";
import { Actions } from "#utils/actions.ts";
import { supportsComments, supportsDocumentEditor } from "#utils/documentTypes.ts";
import { extensions } from "#utils/extensions.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "#utils/formattingActions.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import Canvas from "./Canvas.vue";
import CommentBubble from "./CommentBubble.vue";
import CommentOverlays from "./CommentOverlays.vue";
import "#editor/elements/table-view.ts";
import "#editor/elements/toolbar.ts";
import "#components/document-statusbar.ts";
import { twMerge } from "tailwind-merge";

type DocumentContentPresenceState = DocumentPresenceState | CanvasPresenceState;

const props = withDefaults(
  defineProps<{
    documentId?: string;
    initialHtml?: string;
    documentType?: string;
    readonly?: boolean;
    spaceId: string;
  }>(),
  {
    initialHtml: "",
    documentType: "document",
    readonly: false,
  },
);

const documentId = computed(() => props.documentId);
const documentType = computed(() => props.documentType || "document");
const documentReadonly = computed(() => props.readonly);
const supportsRichTextDocument = computed(() =>
  supportsDocumentEditor(documentType.value),
);

const { currentSpaceId } = useSpace();
const pendingReload = ref(false);
const renderedHtml = ref(props.initialHtml || "");
const isMounted = ref(false);
const commentBubble = ref<InstanceType<typeof CommentBubble> | null>(null);
type DocumentViewElement = HTMLElement & {
  editorInstance?: Editor;
  collaborationDocument?: Y.Doc;
  destroyEditor?: () => void;
  setEditorEnabled?: (enabled: boolean, ydoc?: Y.Doc) => void;
  renderReadHtml?: (html: string) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};
type DocumentToolbarElement = HTMLElement & {
  editor?: Editor;
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};
const documentViewEl = shallowRef<DocumentViewElement | null>(null);
const documentToolbar = shallowRef<DocumentToolbarElement | null>(null);
const editor = shallowRef<Editor>();
const handleVisibilityChange = () => {
  if (pendingReload.value && document.visibilityState === "visible") {
    pendingReload.value = false;
    reloadIfReady();
  }
};

resetEditingState();

const collaboration = useCollaboration<DocumentContentPresenceState>({
  spaceId: props.spaceId,
  documentId,
});
provideCollaboration(collaboration);

const {
  editing,
  cancelCount,
  hasChanges,
  shouldMountEditor,
  canMountEditor,
  suggestionSavedCount,
} = useEditor({
  spaceId: props.spaceId,
  documentId,
  documentType,
  readonly: documentReadonly,
  getEditorHtml: () => editor.value?.getHTML() ?? null,
  collaboration,
});
const { handleInlineSuggestionAccept, handleInlineSuggestionDecline } =
  useInlineSuggestions({
    spaceId: currentSpaceId,
    documentId,
    isEditing: editing,
    editor,
  });

const canvasPresenceProfiles = computed(() =>
  collaboration.presenceProfiles.value.filter(
    (profile): profile is CollaborationPresenceProfile<CanvasPresenceState> =>
      profile.state?.kind === "canvas",
  ),
);

function currentPresenceState(): DocumentPresenceState {
  const currentEditor = editor.value;
  if (!currentEditor) {
    return { kind: "editor", focused: false, selection: null };
  }

  const syncState = findYSyncState(currentEditor);
  if (!syncState?.binding) {
    return { kind: "editor", focused: false, selection: null };
  }

  try {
    const focused = currentEditor.isFocused || currentEditor.view.hasFocus();
    const selection = currentEditor.state.selection;
    const { anchor, head } = getRelativeSelection(syncState.binding, currentEditor.state);
    return {
      kind: "editor",
      focused,
      selection: {
        anchor: Y.relativePositionToJSON(anchor),
        head: Y.relativePositionToJSON(head),
        absoluteAnchor: selection.anchor,
        absoluteHead: selection.head,
      },
    };
  } catch {
    return { kind: "editor", focused: false, selection: null };
  }
}

let leaveEditorPresenceSubscriptions: (() => void) | null = null;

function setupDocumentPresence() {
  if (!documentId.value || !supportsRichTextDocument.value) {
    collaboration.clearPresence();
    return;
  }

  collaboration.setPresenceState(currentPresenceState());
  void collaboration.setupPresence();
}

function handleCanvasPresence(states: CanvasPresenceState[]) {
  const [state] = states;
  if (!state) {
    collaboration.clearPresence();
    return;
  }

  void collaboration.joinUntilReady();
  collaboration.setPresenceState(state);
  void collaboration.setupPresence();
  collaboration.updatePresence(state);
}

function clearEditorPresenceSubscriptions() {
  leaveEditorPresenceSubscriptions?.();
  leaveEditorPresenceSubscriptions = null;
}

function setCurrentEditor(nextEditor: Editor | undefined) {
  if (editor.value === nextEditor) return;

  clearEditorPresenceSubscriptions();
  editor.value = nextEditor;
  if (documentToolbar.value) {
    documentToolbar.value.editor = nextEditor;
  }
  setActiveEditor(nextEditor ?? null);

  if (!nextEditor) {
    collaboration.updatePresence(currentPresenceState());
    return;
  }

  const updatePresence = () => {
    collaboration.updatePresence(currentPresenceState());
  };

  const trackLocalChange = ({
    transaction,
  }: {
    transaction: { docChanged: boolean; getMeta: (key: string) => unknown };
  }) => {
    if (transaction.docChanged && !transaction.getMeta("y-sync$")) {
      hasChanges.value = true;
    }
  };

  nextEditor.on("selectionUpdate", updatePresence);
  nextEditor.on("focus", updatePresence);
  nextEditor.on("blur", updatePresence);
  nextEditor.on("transaction", updatePresence);
  nextEditor.on("update", trackLocalChange as Parameters<typeof nextEditor.on>[1]);
  updatePresence();

  leaveEditorPresenceSubscriptions = () => {
    nextEditor.off("selectionUpdate", updatePresence);
    nextEditor.off("focus", updatePresence);
    nextEditor.off("blur", updatePresence);
    nextEditor.off("transaction", updatePresence);
    nextEditor.off("update", trackLocalChange as Parameters<typeof nextEditor.on>[1]);
  };
}

watch(cancelCount, async () => {
  if (typeof documentData.value?.content === "string") {
    renderedHtml.value = documentData.value.content;
  }
  await nextTick();
  documentViewEl.value?.renderReadHtml?.(renderedHtml.value);
  reloadIfReady();
});

watch(suggestionSavedCount, () => {
  refreshDocument();
});

watch(
  [collaboration.presenceProfiles, editor],
  ([profiles]) => {
    const editorProfiles = profiles.filter(
      (profile): profile is CollaborationPresenceProfile<DocumentPresenceState> =>
        profile.state?.kind === "editor",
    );
    documentViewEl.value?.setPresenceProfiles?.(editorProfiles);
  },
  { immediate: true },
);

watch(documentToolbar, (toolbar) => {
  if (toolbar) {
    toolbar.editor = editor.value;
  }
});

watch(
  [documentViewEl, collaboration.ydoc, shouldMountEditor, canMountEditor],
  ([view, ydoc, shouldMount, canMount]) => {
    if (!view) return;

    const enabled = shouldMount && canMount;
    if (view.setEditorEnabled) {
      view.setEditorEnabled(enabled, ydoc);
      return;
    }

    view.collaborationDocument = ydoc;
    if (enabled) {
      view.setAttribute("editor", "");
    } else {
      view.removeAttribute("editor");
    }
  },
  { immediate: true },
);

watch(
  documentViewEl,
  (view, _previousView, onCleanup) => {
    setCurrentEditor(view?.editorInstance);
    if (!view) return;

    const handleEditorReady = (event: Event) => {
      setCurrentEditor((event as CustomEvent<{ editor: Editor }>).detail.editor);
    };
    const handleEditorDestroyed = (event: Event) => {
      const destroyedEditor = (event as CustomEvent<{ editor: Editor }>).detail.editor;
      if (editor.value === destroyedEditor) {
        setCurrentEditor(undefined);
      }
    };

    view.addEventListener("editor-ready", handleEditorReady);
    view.addEventListener("editor-destroyed", handleEditorDestroyed);
    onCleanup(() => {
      view.removeEventListener("editor-ready", handleEditorReady);
      view.removeEventListener("editor-destroyed", handleEditorDestroyed);
    });
  },
  { immediate: true },
);

let toolbarActionsRegistered = false;
let leaveToolbarActionSubscriptions: Array<() => void> = [];
let formattingActionsRegistered = false;
let autoEditModeAppliedForDocumentId: string | undefined | null;

function registerEditorActions() {
  if (formattingActionsRegistered) return;

  registerFormattingActions(() => editor.value as Editor);
  formattingActionsRegistered = true;
}

function unregisterEditorActions() {
  if (!formattingActionsRegistered) return;

  unregisterFormattingActions();
  formattingActionsRegistered = false;
}

function registerToolbarActions() {
  if (toolbarActionsRegistered) return;

  Actions.register("toolbar:dismiss", {
    title: "Dismiss toolbar",
    description: "Hide the editor toolbar",
    group: "formatting",
    run: async () => {
      documentToolbar.value?.dismiss?.();
    },
  });
  Actions.mapShortcut("escape", "toolbar:dismiss");
  leaveToolbarActionSubscriptions = [
    Actions.subscribe("format:color:text:open", () => {
      documentToolbar.value?.openTextColorPicker?.();
    }),
    Actions.subscribe("format:color:background:open", () => {
      documentToolbar.value?.openBackgroundColorPicker?.();
    }),
  ];
  toolbarActionsRegistered = true;
}

function unregisterToolbarActions() {
  if (!toolbarActionsRegistered) return;

  Actions.unmapShortcut("escape", "toolbar:dismiss");
  Actions.unregister("toolbar:dismiss");
  for (const leave of leaveToolbarActionSubscriptions) {
    leave();
  }
  leaveToolbarActionSubscriptions = [];
  toolbarActionsRegistered = false;
}

function shouldAutoStartEditMode() {
  if (!canMountEditor.value) return false;
  if (!documentId.value) return true;
  return documentData.value?.publishedRev === null;
}

function maybeStartAutoEditMode() {
  const currentDocumentId = documentId.value ?? null;
  if (
    shouldAutoStartEditMode() &&
    autoEditModeAppliedForDocumentId !== currentDocumentId
  ) {
    autoEditModeAppliedForDocumentId = currentDocumentId;
    editing.value = true;
  }
}

watch(editing, (isEditing) => {
  if (isEditing) {
    registerEditorActions();
    registerToolbarActions();
  } else {
    unregisterEditorActions();
    unregisterToolbarActions();
  }
});

onMounted(() => {
  extensions.setActiveCollaboration(collaboration.ydoc.value);
  extensions.setActiveDocumentId(documentId.value ?? null);
  isMounted.value = true;

  window.addEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );
  window.addEventListener(
    "inline-suggestion:decline",
    handleInlineSuggestionDecline as EventListener,
  );

  window.addEventListener("visibilitychange", handleVisibilityChange);

  setupDocumentPresence();
  maybeStartAutoEditMode();
});

onUnmounted(() => {
  extensions.setActiveCollaboration(null);
  extensions.setActiveDocumentId(null);
  setCurrentEditor(undefined);
  collaboration.clearPresence();
  unregisterEditorActions();
  unregisterToolbarActions();
  setActiveEditor(null);
  window.removeEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );
  window.removeEventListener(
    "inline-suggestion:decline",
    handleInlineSuggestionDecline as EventListener,
  );
  window.removeEventListener("visibilitychange", handleVisibilityChange);
});

function reloadIfReady() {
  if (editing.value) return;
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
  maybeStartAutoEditMode();
  const layout = Array.isArray(doc.properties?.layout)
    ? doc.properties.layout[0]
    : doc.properties?.layout;
  const full =
    layout === "full" ||
    (!layout && (documentType.value === "csv" || documentType.value === "canvas"));
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
    <main :class="twMerge('relative', documentType !== 'canvas' && 'mb-30')">
        <!-- CSV Spreadsheet View -->
        <table-view v-if="!editing && documentType === 'csv'"
            :html="renderedHtml" class="block flex-1 min-h-0"></table-view>

        <!-- Document View (read + edit, single persistent instance) -->
        <div v-if="supportsRichTextDocument"
            :class="editing ? 'h-full' : ''">
            <document-view ref="documentViewEl"
                :html="renderedHtml"
                :space-id="props.spaceId" :document-id="documentId"
                data-allow-mismatch="children"
                v-html="ssrDeclarativeShadowDom" />
        </div>

        <div v-if="isMounted && documentType === 'canvas'" class="h-screen">
            <Canvas
                :documentId="documentId"
                :spaceId="props.spaceId"
                :ydoc="collaboration.ydoc.value"
                :presenceProfiles="canvasPresenceProfiles"
                @presence="handleCanvasPresence"
            />
        </div>

        <div><!-- DON'T REMOVE; This fixes shadowDOM content not visible in print preview --></div>
    </main>

    <template v-if="documentId && supportsComments(documentType)">
        <CommentBubble ref="commentBubble" :spaceId="props.spaceId" :documentId="documentId"
            :currentRev="documentData?.currentRev" :editor="editor" />
        <CommentOverlays :comments="commentBubble?.commentsForOverlays ?? []"
            @move="commentBubble?.handleMoveThread($event)" />
    </template>

    <document-statusbar
        v-if="editing && canMountEditor"
        class="fixed inset-x-0 bottom-0 z-10 mx-auto block max-w-[calc(var(--document-width)+1.5rem)] overflow-hidden px-xs lg:px-xl pb-4 pointer-events-none md:left-(--inset-left) md:right-(--inset-right)"
    ></document-statusbar>

    <document-toolbar ref="documentToolbar"
        :data-comments-enabled="supportsComments(documentType) ? '' : undefined"></document-toolbar>
</template>
