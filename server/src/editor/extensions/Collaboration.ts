import { Extension } from "@tiptap/core";
import type { Plugin } from "@tiptap/pm/state";
import { redo, undo, ySyncPlugin, yUndoPlugin, yUndoPluginKey } from "y-prosemirror";
import type * as Y from "yjs";

export interface CollaborationOptions {
  /** The room's document; the bound fragment is `field` on it. */
  document: Y.Doc | null;
  field: string;
  /** Set instead of `document` to bind a fragment the caller already holds. */
  fragment: Y.XmlFragment | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    collaboration: {
      undo: () => ReturnType;
      redo: () => ReturnType;
    };
  }
}

/** The `restore` closure a destroyed plugin view parks on the UndoManager. */
type RestorableUndoManager = Y.UndoManager & { restore?: () => void };

/**
 * ProseMirror tears down and rebuilds every plugin view whenever the plugin set
 * changes, but `EditorState.reconfigure` keeps the undo plugin's state — so the
 * teardown destroys the UndoManager that the surviving state still points at.
 */
function keepUndoManagerAcrossViews(plugin: Plugin): Plugin {
  const createView = plugin.spec.view;

  plugin.spec.view = (view) => {
    const undoManager = yUndoPluginKey.getState(view.state)?.undoManager as
      | RestorableUndoManager
      | undefined;
    undoManager?.restore?.();
    if (undoManager) undoManager.restore = undefined;

    const pluginView = createView?.(view);

    return {
      ...pluginView,
      destroy: () => {
        // `UndoManager.destroy()` drops these three, so capture them before it
        // runs and hand a later view the means to put the manager back to work.
        if (undoManager) {
          const trackedItself = undoManager.trackedOrigins.has(undoManager);
          const observers = undoManager._observers;
          undoManager.restore = () => {
            if (trackedItself) undoManager.trackedOrigins.add(undoManager);
            undoManager.doc.on("afterTransaction", undoManager.afterTransactionHandler);
            undoManager._observers = observers;
          };
        }
        pluginView?.destroy?.();
      },
    };
  };

  return plugin;
}

/**
 * Binds the editor to a Yjs fragment and routes history through the shared
 * UndoManager, so undo only ever takes back the local user's own edits.
 */
export const Collaboration = Extension.create<CollaborationOptions>({
  name: "collaboration",
  priority: 1000,

  addOptions() {
    return { document: null, field: "default", fragment: null };
  },

  addCommands() {
    return {
      undo:
        () =>
        ({ tr, state, dispatch }) => {
          // The UndoManager dispatches its own transaction.
          tr.setMeta("preventDispatch", true);
          if (!yUndoPluginKey.getState(state)?.undoManager.canUndo()) return false;
          return dispatch ? undo(state) : true;
        },
      redo:
        () =>
        ({ tr, state, dispatch }) => {
          tr.setMeta("preventDispatch", true);
          if (!yUndoPluginKey.getState(state)?.undoManager.canRedo()) return false;
          return dispatch ? redo(state) : true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-z": () => this.editor.commands.undo(),
      "Mod-y": () => this.editor.commands.redo(),
      "Shift-Mod-z": () => this.editor.commands.redo(),
    };
  },

  addProseMirrorPlugins() {
    const fragment =
      this.options.fragment ?? this.options.document?.getXmlFragment(this.options.field);
    if (!fragment) {
      throw new Error("Collaboration needs either a `document` or a `fragment`");
    }

    return [ySyncPlugin(fragment), keepUndoManagerAcrossViews(yUndoPlugin())];
  },
});
