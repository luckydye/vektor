import type { Editor } from "@tiptap/core";
import { onUnmounted, type Ref, ref, watch } from "vue";
import type { DocumentPresenceProfile } from "../editor/collaboration.ts";
import { Actions } from "../utils/actions.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "../utils/formattingActions.ts";
import type { SaveStatus } from "./useDocument.ts";
import { useEditorPresence } from "./useEditorPresence.ts";

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

type DocumentViewElement = {
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};

type DocumentToolbarElement = {
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};

type EditorRoom = {
  joinUntilReady: () => Promise<void>;
  leave: () => void;
};

type UseEditorOptions = {
  spaceId: string;
  documentId: Ref<string | undefined>;
  canMountEditor: Ref<boolean>;
  documentViewEl: Ref<DocumentViewElement | null>;
  documentToolbar: Ref<DocumentToolbarElement | null>;
  editorRoom: EditorRoom;
  getEditor: () => Editor | undefined;
  documentSaveStatus: Ref<SaveStatus>;
  documentSaveError: Ref<string | null>;
  saveDocument: (content: string) => Promise<boolean>;
  saveRevision: (
    html: string,
    message?: string,
    mode?: SaveMode,
  ) => Promise<unknown | null>;
  refreshDocument: () => Promise<unknown> | unknown;
};

export function useEditor(options?: UseEditorOptions) {
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

  const {
    spaceId,
    documentId,
    canMountEditor,
    documentViewEl,
    documentToolbar,
    editorRoom,
    getEditor,
    documentSaveStatus,
    documentSaveError,
    saveDocument,
    saveRevision,
    refreshDocument,
  } = options;

  const { setupEditorPresence, clearEditorPresence } = useEditorPresence({
    spaceId,
    documentId,
    documentViewEl,
    getEditor,
    isActive: editing,
  });

  let editorActionsRegistered = false;
  let leaveEditorActionSubscriptions: Array<() => void> = [];
  let editorSession = 0;
  let saveStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSaveStatusTimer() {
    if (!saveStatusTimer) return;
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }

  function registerEditorActions() {
    if (editorActionsRegistered) return;

    registerFormattingActions();
    Actions.register("toolbar:dismiss", {
      title: "Dismiss toolbar",
      description: "Hide the editor toolbar",
      group: "formatting",
      run: async () => {
        documentToolbar.value?.dismiss?.();
      },
    });
    Actions.mapShortcut("escape", "toolbar:dismiss");

    leaveEditorActionSubscriptions = [
      Actions.subscribe("format:color:text:open", () => {
        documentToolbar.value?.openTextColorPicker?.();
      }),
      Actions.subscribe("format:color:background:open", () => {
        documentToolbar.value?.openBackgroundColorPicker?.();
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

  async function finishEditing(mode: SaveMode = "revision") {
    clearSaveStatusTimer();
    saveStatus.value = "saving";
    saveError.value = null;

    let saved = false;
    try {
      const editor = getEditor();
      if (editor) {
        const content = editor.getHTML();
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

    if (mode === "suggestion") {
      await refreshDocument();
    }
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
    registerEditorActions();
    void setupEditorPresence();
    await editorRoom.joinUntilReady();
    if (!editing.value || session !== editorSession) return;

    shouldMountEditor.value = true;
  }

  function stopEditorSession() {
    editorSession++;
    unregisterSaveActions();
    unregisterEditorActions();
    clearEditorPresence();
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
    unregisterEditorActions();
    editorRoom.leave();
    clearEditorPresence();
    clearSaveStatusTimer();
  });

  return {
    editing,
    saveStatus,
    saveError,
    cancelCount,
    resetEditingState,
    shouldMountEditor,
    finishEditing,
    startEditorSession,
    stopEditorSession,
  };
}
