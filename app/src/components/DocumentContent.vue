<script setup lang="ts">
import type { Editor } from "@tiptap/core";
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { absolutePositionToRelativePosition } from "y-prosemirror";
import type * as Y from "yjs";
import { api } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import { useEditor } from "../composeables/useEditor.ts";
import { useEditorPresence } from "../composeables/useEditorPresence.ts";
import { useInlineSuggestions } from "../composeables/useInlineSuggestions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { useSync } from "../composeables/useSync.ts";
import { setActiveEditor } from "../editor/activeEditor.ts";
import { type DocumentPresenceProfile, findYSyncState } from "../editor/collaboration.ts";
import docStyles from "../styles/document.css?inline";
import { Actions } from "../utils/actions.ts";
import { supportsComments } from "../utils/documentTypes.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "../utils/formattingActions.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import Canvas from "./Canvas.vue";
import CommentBubble from "./CommentBubble.vue";
import CommentOverlays from "./CommentOverlays.vue";
import "../editor/elements/table-view.ts";
import "../editor/elements/toolbar.ts";
import "../components/document-statusbar.ts";

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

const { currentSpaceId } = useSpace();
const pendingReload = ref(false);
const renderedHtml = ref(props.initialHtml || "");
const isMounted = ref(false);
const commentBubble = ref<InstanceType<typeof CommentBubble> | null>(null);
type DocumentViewElement = HTMLElement & {
  editorInstance?: Editor;
  collaborationDocument?: Y.Doc;
  destroyEditor?: () => void;
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
type DocumentPresenceState = NonNullable<DocumentPresenceProfile["state"]>;
const handleVisibilityChange = () => {
  if (pendingReload.value && document.visibilityState === "visible") {
    pendingReload.value = false;
    reloadIfReady();
  }
};

const {
  editing,
  cancelCount,
  resetEditingState,
  shouldMountEditor,
  canMountEditor,
  editorYdoc,
  suggestionSavedCount,
} = useEditor({
  spaceId: props.spaceId,
  documentId,
  documentType,
  readonly: documentReadonly,
  getEditorHtml: () => editor.value?.getHTML() ?? null,
});
const { setupEditorPresence, clearEditorPresence, presenceProfiles } = useEditorPresence({
  spaceId: props.spaceId,
  documentId,
  currentState: currentPresenceState,
  isActive: editing,
});
const { handleInlineSuggestionAccept } = useInlineSuggestions({
  spaceId: currentSpaceId,
  documentId,
  isEditing: editing,
  editor,
});

function currentPresenceState(): DocumentPresenceState {
  const currentEditor = editor.value;
  if (!currentEditor) {
    return { kind: "editor", focused: false, selection: null };
  }

  const focused = currentEditor.isFocused || currentEditor.view.hasFocus();
  if (!focused) {
    return { kind: "editor", focused: false, selection: null };
  }

  const syncState = findYSyncState(currentEditor);
  const mapping = syncState?.binding?.mapping;
  if (!mapping) {
    return { kind: "editor", focused: false, selection: null };
  }

  try {
    const { anchor, head } = currentEditor.state.selection;
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

watch(cancelCount, () => {
  if (typeof documentData.value?.content === "string") {
    renderedHtml.value = documentData.value.content;
  }
  reloadIfReady();
});

watch(suggestionSavedCount, () => {
  refreshDocument();
});

watch(presenceProfiles, (profiles) => {
  documentViewEl.value?.setPresenceProfiles?.(profiles);
});

watch(editor, (currentEditor) => {
  if (documentToolbar.value) {
    documentToolbar.value.editor = currentEditor;
  }
  setActiveEditor(currentEditor ?? null);
});

watch(documentToolbar, (toolbar) => {
  if (toolbar) {
    toolbar.editor = editor.value;
  }
});

watch(
  documentViewEl,
  (view, _previousView, onCleanup) => {
    editor.value = view?.editorInstance;
    if (!view) return;

    const handleEditorReady = (event: Event) => {
      editor.value = (event as CustomEvent<{ editor: Editor }>).detail.editor;
    };
    const handleEditorDestroyed = (event: Event) => {
      const destroyedEditor = (event as CustomEvent<{ editor: Editor }>).detail.editor;
      if (editor.value === destroyedEditor) {
        editor.value = undefined;
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

watch(editing, (isEditing) => {
  if (isEditing) {
    void setupEditorPresence();
    registerEditorActions();
    registerToolbarActions();
  } else {
    clearEditorPresence();
    unregisterEditorActions();
    unregisterToolbarActions();
  }
});

onMounted(() => {
  resetEditingState();
  isMounted.value = true;

  window.addEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );

  window.addEventListener("visibilitychange", handleVisibilityChange);

  if (props.initialEditMode && canMountEditor.value) {
    editing.value = true;
  }
});

onUnmounted(() => {
  clearEditorPresence();
  unregisterEditorActions();
  unregisterToolbarActions();
  setActiveEditor(null);
  window.removeEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
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
        <table-view v-if="!editing && documentType === 'csv'"
            :html="renderedHtml" class="block flex-1 min-h-0"></table-view>

        <!-- Document View (read + edit, single persistent instance) -->
        <div v-if="documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
            :class="editing ? 'h-full' : ''">
            <document-view ref="documentViewEl"
                :editor="shouldMountEditor && !documentReadonly ? '' : undefined"
                :collaborationDocument="editorYdoc"
                :html="renderedHtml"
                :space-id="props.spaceId" :document-id="documentId"
                v-html="ssrDeclarativeShadowDom" />
        </div>

        <div v-if="isMounted && documentType === 'canvas'" class="h-screen">
            <Canvas :documentId="documentId" :spaceId="props.spaceId" />
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
        v-if="editing && !documentReadonly && documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
        class="block sticky left-0 bottom-0 pb-6 pt-20 bg-linear-to-b from-transparent to-neutral-10 pointer-events-none"></document-statusbar>
        
    <document-toolbar ref="documentToolbar"
        :data-comments-enabled="supportsComments(documentType) ? '' : undefined"></document-toolbar>
</template>
