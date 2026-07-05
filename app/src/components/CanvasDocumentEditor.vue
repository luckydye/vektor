<script setup lang="ts">
// Inline collaborative editor for a document embedded on the canvas. Mounted
// only for the embed the user activated, it joins the embedded document's own
// Yjs room and joins its presence room lazily — on the first editor focus —
// so idle embeds never hold an editor or appear as present.
import type { Editor } from "@tiptap/core";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type * as Y from "yjs";
import { documentIcon } from "~/src/assets/icons.ts";
import { useCollaboration } from "../composeables/useCollaboration.ts";
import {
  currentEditorPresenceState,
  type DocumentPresenceProfile,
  type DocumentPresenceState,
} from "../editor/collaboration.ts";

const props = defineProps<{
  spaceId: string;
  documentId: string;
  title: string;
}>();

const emit = defineEmits<{
  exit: [];
  dragStart: [event: PointerEvent];
}>();

type DocumentViewElement = HTMLElement & {
  editorInstance?: Editor;
  setEditorEnabled?: (enabled: boolean, ydoc?: Y.Doc) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};

const viewEl = shallowRef<DocumentViewElement | null>(null);
const editor = shallowRef<Editor>();
const status = ref<"connecting" | "ready" | "error">("connecting");
const errorMessage = ref("");

const collaboration = useCollaboration<DocumentPresenceState>({
  spaceId: props.spaceId,
  documentId: computed(() => props.documentId),
});

let leaveEditorSubscriptions: (() => void) | null = null;

function broadcastEditorPresence() {
  const state = currentEditorPresenceState(editor.value);
  collaboration.setPresenceState(state);
  // Join the presence room only once the editor actually holds focus.
  if (state.focused) void collaboration.setupPresence();
  collaboration.updatePresence();
}

function setEditor(nextEditor: Editor | undefined) {
  if (editor.value === nextEditor) return;

  leaveEditorSubscriptions?.();
  leaveEditorSubscriptions = null;
  editor.value = nextEditor;
  if (!nextEditor) return;

  nextEditor.on("focus", broadcastEditorPresence);
  nextEditor.on("blur", broadcastEditorPresence);
  nextEditor.on("selectionUpdate", broadcastEditorPresence);
  nextEditor.on("transaction", broadcastEditorPresence);
  broadcastEditorPresence();

  leaveEditorSubscriptions = () => {
    nextEditor.off("focus", broadcastEditorPresence);
    nextEditor.off("blur", broadcastEditorPresence);
    nextEditor.off("selectionUpdate", broadcastEditorPresence);
    nextEditor.off("transaction", broadcastEditorPresence);
  };
}

watch(
  viewEl,
  (view, _previousView, onCleanup) => {
    if (!view) return;

    view.setEditorEnabled?.(true, collaboration.ydoc.value);
    setEditor(view.editorInstance);

    const handleEditorReady = (event: Event) => {
      setEditor((event as CustomEvent<{ editor: Editor }>).detail.editor);
    };
    const handleEditorDestroyed = () => {
      setEditor(undefined);
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

watch(
  [collaboration.presenceProfiles, editor],
  ([profiles]) => {
    viewEl.value?.setPresenceProfiles?.(profiles);
  },
  { immediate: true },
);

let disposed = false;

onMounted(async () => {
  try {
    // document-view is loaded lazily so the canvas chunk stays lean; Canvas
    // prefetches it on mount, making this await effectively instant.
    await import("../editor/document.ts");
    await customElements.whenDefined("document-view");
    await collaboration.joinUntilReady();
    if (disposed) return;
    status.value = "ready";
  } catch (error) {
    if (disposed) return;
    status.value = "error";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  setEditor(undefined);
  viewEl.value?.setEditorEnabled?.(false);
});

function onKeydown(event: KeyboardEvent) {
  // Keep typing from triggering canvas shortcuts (tool switches, Delete).
  event.stopPropagation();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    // Collaborative edits persist automatically; swallow the browser dialog.
    event.preventDefault();
    return;
  }
  if (event.key === "Escape") emit("exit");
}

defineExpose({
  getHtml(): string | null {
    return editor.value?.getHTML() ?? null;
  },
});
</script>

<template>
  <div
    class="canvas-doc-editor"
    @pointerdown.stop
    @dblclick.stop
    @contextmenu.stop
    @wheel.stop
    @keydown="onKeydown"
    @keyup.stop
    @copy.stop
    @cut.stop
    @paste.stop
  >
    <div class="editor-header" @pointerdown.stop="emit('dragStart', $event)">
      <span class="svg-icon icon" aria-hidden="true" v-html="documentIcon"></span>
      <span class="title-wrap">
        <span class="title">{{ props.title }}</span>
        <span class="type">Editing</span>
      </span>
      <button type="button" class="done" @pointerdown.stop @click="emit('exit')">
        Done
      </button>
    </div>
    <div class="editor-body">
      <p v-if="status === 'connecting'" class="editor-hint">Connecting…</p>
      <p v-else-if="status === 'error'" class="editor-hint">
        {{ errorMessage || "Unable to open the editor." }}
      </p>
      <document-view
        v-else
        ref="viewEl"
        :space-id="props.spaceId"
        :document-id="props.documentId"
      ></document-view>
    </div>
  </div>
</template>

<style scoped>
.canvas-doc-editor {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  cursor: auto;
  color: var(--canvas-text, #111827);
  font: inherit;
}

.editor-header {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
  padding: 10px 12px;
  cursor: move;
}

.icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--canvas-doc-accent, #2563eb);
}

.title-wrap {
  min-width: 0;
  flex: 1 1 auto;
}

.title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
}

.type {
  display: block;
  margin-top: 2px;
  color: var(--canvas-doc-accent, #2563eb);
  font-size: 11px;
  line-height: 1.1;
}

.done {
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  background: var(--canvas-doc-accent, #2563eb);
  padding: 4px 10px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}

.editor-body {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 12px 14px 16px;
  scrollbar-width: thin;
}

.editor-body document-view {
  display: block;
  min-width: 0;
}

.editor-hint {
  margin: 0;
  color: var(--canvas-muted, #6b7280);
  font-size: 13px;
  line-height: 1.4;
}
</style>
