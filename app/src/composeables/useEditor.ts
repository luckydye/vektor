import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { supportsDocumentEditor } from "#documents/types.ts";
import { setEditSessionCancelHandler } from "#editor/editSession.ts";
import { Actions } from "#utils/actions.ts";
import type { CollaborationSession } from "./useCollaboration.ts";
import { type SaveStatus, useDocument } from "./useDocument.ts";
import { useRevisions } from "./useRevisions.ts";
import { useToast } from "./useToast.ts";

export type SaveMode = "revision" | "suggestion";

/** Whether the user has an active editing session on the current document. */
export const [editing, setEditing] = createSignal(false);

/** Save status for the active document edit session. */
export const [saveStatus, setSaveStatus] = createSignal<SaveStatus | "">("");
export const [saveError, setSaveError] = createSignal<Error | null>(null);

/** Whether the document content has changed since the edit session started. */
export const [hasChanges, setHasChanges] = createSignal(false);

/**
 * Incremented each time the user explicitly cancels editing (as opposed to
 * saving). DocumentContent watches this to run cancel-specific cleanup
 * (discard unsaved HTML, cancel the debounce).
 */
export const [cancelCount, setCancelCount] = createSignal(0);

// The editor keymap handles Escape inside its shadow-DOM contenteditable, but
// the extension that owns that keymap is also built on the server to derive the
// document schema — so it must not import a framework. Register it from this
// (client-only) module instead; on the server no handler is ever registered and
// Escape simply falls through. See `#editor/editSession.ts`.
setEditSessionCancelHandler(() => {
  if (!editing()) return false;
  setEditing(false);
  setCancelCount((count) => count + 1);
  return true;
});

/** Called by DocumentContent on mount to clear any stale state from a previous page. */
export function resetEditingState() {
  setEditing(false);
  setSaveStatus("");
  setSaveError(null);
  setHasChanges(false);
}

type UseEditorOptions = {
  spaceId: string;
  documentId: Accessor<string | undefined>;
  documentType: Accessor<string>;
  readonly: Accessor<boolean>;
  getEditorHtml: () => string | null;
  /**
   * Only the room lifecycle is used here, so the presence payload type is
   * irrelevant. Picking the two methods keeps a `CollaborationSession<T>` for
   * any `T` assignable — the full `CollaborationSession<unknown>` would not be,
   * because `setPresenceState` is contravariant in `T`.
   */
  collaboration: Pick<CollaborationSession, "joinUntilReady" | "leave">;
  onSessionStarted?: () => void;
};

type EditorState = {
  editing: typeof editing;
  saveStatus: typeof saveStatus;
  saveError: typeof saveError;
  hasChanges: typeof hasChanges;
  cancelCount: typeof cancelCount;
  resetEditingState: typeof resetEditingState;
  shouldMountEditor: Accessor<boolean>;
};

type DocumentEditor = EditorState & {
  canMountEditor: Accessor<boolean>;
  suggestionSavedCount: Accessor<number>;
  finishEditing: (mode: SaveMode) => Promise<void>;
  startEditorSession: () => Promise<void>;
  stopEditorSession: () => void;
};

export function useEditor(): EditorState;
export function useEditor(options: UseEditorOptions): DocumentEditor;
export function useEditor(options?: UseEditorOptions): EditorState | DocumentEditor {
  const [shouldMountEditor, setShouldMountEditor] = createSignal(false);

  if (!options) {
    return {
      editing,
      saveStatus,
      saveError,
      hasChanges,
      cancelCount,
      resetEditingState,
      shouldMountEditor,
    };
  }

  const {
    documentId,
    documentType,
    readonly,
    getEditorHtml,
    collaboration,
    onSessionStarted,
  } = options;

  const [suggestionSavedCount, setSuggestionSavedCount] = createSignal(0);
  const canMountEditor = createMemo(
    () => !readonly() && supportsDocumentEditor(documentType()),
  );
  const {
    saveStatus: documentSaveStatus,
    saveError: documentSaveError,
    saveDocument,
  } = useDocument(documentId, documentType);
  const { saveRevision } = useRevisions(documentId);
  const toast = useToast();

  let editorSession = 0;
  let saveStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSaveStatusTimer() {
    if (!saveStatusTimer) return;
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }

  async function finishEditing(mode: SaveMode) {
    // Guard against re-entrancy (double-clicked button, or a shortcut firing
    // via both the editor keymap and the global handler) so we never publish
    // the same draft twice.
    if (saveStatus() === "saving") return;
    clearSaveStatusTimer();
    setSaveStatus("saving");
    setSaveError(null);

    let saved = false;
    try {
      const content = getEditorHtml();
      if (content) {
        if (mode === "suggestion") {
          saved = !!(await saveRevision(content, "Suggested changes", "suggestion"));
        } else {
          saved = await saveDocument(content, { publish: mode === "revision" });
        }
      }
    } catch (error) {
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (!saved) {
      setSaveStatus("idle");
      return;
    }

    setEditing(false);
    setHasChanges(false);
    setSaveStatus("saved");
    saveStatusTimer = setTimeout(() => {
      if (saveStatus() === "saved") {
        setSaveStatus("idle");
      }
    }, 2000);

    if (mode === "suggestion") setSuggestionSavedCount((count) => count + 1);
    else toast.success("Document published");
  }

  function registerSaveActions() {
    Actions.register("document:save:publish", {
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
    Actions.unregister("document:save:publish");
    Actions.unregister("document:save:suggestion");
  }

  async function startEditorSession() {
    const session = ++editorSession;
    if (!canMountEditor()) return;
    registerSaveActions();
    try {
      await collaboration.joinUntilReady();
    } catch (error) {
      if (session === editorSession) {
        setSaveStatus("error");
        setSaveError(error instanceof Error ? error : new Error(String(error)));
        setEditing(false);
      }
      return;
    }
    if (!editing() || session !== editorSession) return;

    setShouldMountEditor(true);
    onSessionStarted?.();
  }

  function stopEditorSession() {
    editorSession++;
    unregisterSaveActions();
    setShouldMountEditor(false);
    collaboration.leave();
  }

  createEffect(
    on([documentSaveStatus, documentSaveError], ([status, error]) => {
      setSaveStatus(status);
      setSaveError(error ? new Error(error) : null);
    }),
  );

  createEffect(
    on(editing, (isEditing) => {
      if (isEditing) {
        void startEditorSession();
        return;
      }

      stopEditorSession();
    }),
  );

  createEffect(
    on(documentId, (currentDocumentId, previousDocumentId) => {
      if (currentDocumentId === previousDocumentId) return;

      stopEditorSession();
      if (editing()) {
        void startEditorSession();
      }
    }),
  );

  onCleanup(() => {
    unregisterSaveActions();
    collaboration.leave();
    clearSaveStatusTimer();
  });

  return {
    editing,
    saveStatus,
    saveError,
    hasChanges,
    cancelCount,
    resetEditingState,
    shouldMountEditor,
    canMountEditor,
    suggestionSavedCount,
    finishEditing,
    startEditorSession,
    stopEditorSession,
  };
}
