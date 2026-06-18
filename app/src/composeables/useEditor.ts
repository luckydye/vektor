import { computed, onUnmounted, type Ref, ref, type ShallowRef, watch } from "vue";
import type * as Y from "yjs";
import { Actions } from "../utils/actions.ts";
import { type SaveStatus, useDocument } from "./useDocument.ts";
import { useRevisions } from "./useRevisions.ts";
import { useYjsDocumentRoom } from "./useYjsDocumentRoom.ts";

export type SaveMode = "revision" | "suggestion";

/** Whether the user has an active editing session on the current document. */
export const editing = ref(false);

/** Save status for the active document edit session. */
export const saveStatus: Ref<SaveStatus | ""> = ref("");
export const saveError = ref<Error | null>(null);

/**
 * Incremented each time the user explicitly cancels editing (as opposed to
 * saving). DocumentContent watches this to run cancel-specific cleanup
 * (discard unsaved HTML, cancel the debounce).
 */
export const cancelCount = ref(0);

/** Called by DocumentContent on mount to clear any stale state from a previous page. */
export function resetEditingState() {
  editing.value = false;
  saveStatus.value = "";
  saveError.value = null;
}

type EditorRoom = {
  ydoc: ShallowRef<Y.Doc>;
  joinUntilReady: () => Promise<void>;
  leave: () => void;
};

type UseEditorOptions = {
  spaceId: string;
  documentId: Ref<string | undefined>;
  documentType: Ref<string>;
  readonly: Ref<boolean>;
  getEditorHtml: () => string | null;
};

type EditorState = {
  editing: typeof editing;
  saveStatus: typeof saveStatus;
  saveError: typeof saveError;
  cancelCount: typeof cancelCount;
  resetEditingState: typeof resetEditingState;
  shouldMountEditor: Ref<boolean>;
};

type DocumentEditor = EditorState & {
  canMountEditor: Ref<boolean>;
  editorYdoc: ShallowRef<Y.Doc>;
  suggestionSavedCount: Ref<number>;
  finishEditing: (mode?: SaveMode) => Promise<void>;
  startEditorSession: () => Promise<void>;
  stopEditorSession: () => void;
};

export function useEditor(): EditorState;
export function useEditor(options: UseEditorOptions): DocumentEditor;
export function useEditor(options?: UseEditorOptions): EditorState | DocumentEditor {
  const shouldMountEditor = ref(false);

  if (!options) {
    return {
      editing,
      saveStatus,
      saveError,
      cancelCount,
      resetEditingState,
      shouldMountEditor,
    };
  }

  const { spaceId, documentId, documentType, readonly, getEditorHtml } = options;

  const suggestionSavedCount = ref(0);
  const canMountEditor = computed(
    () =>
      !readonly.value &&
      documentType.value !== "canvas" &&
      documentType.value !== "app" &&
      documentType.value !== "csv",
  );
  const editorRoom: EditorRoom = useYjsDocumentRoom(spaceId, documentId.value);
  const editorYdoc = editorRoom.ydoc;
  const {
    saveStatus: documentSaveStatus,
    saveError: documentSaveError,
    saveDocument,
  } = useDocument(documentId.value, documentType.value);
  const { saveRevision } = useRevisions(documentId.value);

  let editorSession = 0;
  let saveStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSaveStatusTimer() {
    if (!saveStatusTimer) return;
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }

  async function finishEditing(mode: SaveMode = "revision") {
    clearSaveStatusTimer();
    saveStatus.value = "saving";
    saveError.value = null;

    let saved = false;
    try {
      const content = getEditorHtml();
      if (content) {
        if (mode === "suggestion") {
          saved = !!(await saveRevision(content, "Suggested changes", "suggestion"));
        } else {
          await saveRevision(content, "Manual save");
          saved = await saveDocument(content);
        }
      }
    } catch (error) {
      saveStatus.value = "error";
      saveError.value = error instanceof Error ? error : new Error(String(error));
      return;
    }

    if (!saved) {
      saveStatus.value = "idle";
      return;
    }

    editing.value = false;
    saveStatus.value = "saved";
    saveStatusTimer = setTimeout(() => {
      if (saveStatus.value === "saved") {
        saveStatus.value = "idle";
      }
    }, 2000);

    if (mode === "suggestion") suggestionSavedCount.value++;
  }

  function registerSaveActions() {
    Actions.register("document:save", {
      title: "Publish Document",
      description: "Publish current document and exit edit mode",
      group: "edit",
      run: async () => finishEditing("revision"),
    });

    Actions.register("document:save:suggestion", {
      title: "Save as suggestion",
      description: "Create an open suggestion instead of publishing",
      group: "edit",
      run: async () => finishEditing("suggestion"),
    });
  }

  function unregisterSaveActions() {
    Actions.unregister("document:save");
    Actions.unregister("document:save:suggestion");
  }

  async function startEditorSession() {
    const session = ++editorSession;
    if (!canMountEditor.value) return;
    registerSaveActions();
    await editorRoom.joinUntilReady();
    if (!editing.value || session !== editorSession) return;

    shouldMountEditor.value = true;
  }

  function stopEditorSession() {
    editorSession++;
    unregisterSaveActions();
    shouldMountEditor.value = false;
    editorRoom.leave();
  }

  watch([documentSaveStatus, documentSaveError], () => {
    saveStatus.value = documentSaveStatus.value;
    saveError.value = documentSaveError.value ? new Error(documentSaveError.value) : null;
  });

  watch(editing, (isEditing) => {
    if (isEditing) {
      void startEditorSession();
      return;
    }

    stopEditorSession();
  });

  onUnmounted(() => {
    unregisterSaveActions();
    editorRoom.leave();
    clearSaveStatusTimer();
  });

  return {
    editing,
    saveStatus,
    saveError,
    cancelCount,
    resetEditingState,
    shouldMountEditor,
    canMountEditor,
    editorYdoc,
    suggestionSavedCount,
    finishEditing,
    startEditorSession,
    stopEditorSession,
  };
}
