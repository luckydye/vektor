import type { Editor } from "@tiptap/core";

/** Block node types that support a left-margin indent attribute. */
export const INDENT_TYPES = ["paragraph", "heading"];
/** Maximum indent level a block can reach. */
export const MAX_INDENT = 10;
/** Left margin applied per indent level, in em. */
export const INDENT_STEP_EM = 2;

/**
 * Shift the indent level of every indentable block touched by the current
 * selection by `delta`, clamped to [0, MAX_INDENT]. Returns whether anything
 * changed.
 */
export function shiftBlockIndent(editor: Editor, delta: number): boolean {
  const { state } = editor.view;
  const { from, to } = state.selection;
  const tr = state.tr;
  let changed = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!INDENT_TYPES.includes(node.type.name)) return;
    const current = (node.attrs.indent as number) || 0;
    const next = Math.min(Math.max(current + delta, 0), MAX_INDENT);
    if (next !== current) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
      changed = true;
    }
  });

  if (changed) editor.view.dispatch(tr);
  return changed;
}

/**
 * Code-editor-style indent for the current selection. Returns `false` when the
 * caller should defer to another handler (i.e. inside a table, where Tab means
 * cell navigation); otherwise performs the indent and returns `true`.
 *
 *  - inside a list      -> nest the list item (or no-op at a boundary)
 *  - with a selection   -> indent every selected block
 *  - collapsed cursor   -> insert a literal tab
 */
export function indentEditor(editor: Editor): boolean {
  if (editor.isActive("tableCell") || editor.isActive("tableHeader")) {
    return false;
  }
  if (editor.isActive("taskItem")) {
    if (editor.can().sinkListItem("taskItem")) {
      editor.chain().focus().sinkListItem("taskItem").run();
    }
    return true;
  }
  if (editor.isActive("listItem")) {
    if (editor.can().sinkListItem("listItem")) {
      editor.chain().focus().sinkListItem("listItem").run();
    }
    return true;
  }
  if (!editor.state.selection.empty) {
    shiftBlockIndent(editor, 1);
    return true;
  }
  // Insert a literal tab via a raw transaction so the character survives
  // (insertContent parses as HTML and would collapse it).
  editor.view.dispatch(editor.state.tr.insertText("\t"));
  return true;
}

/**
 * Counterpart to {@link indentEditor}. Returns `false` to defer inside tables.
 *
 *  - inside a list    -> un-nest the list item (or no-op at a boundary)
 *  - collapsed cursor -> delete a literal tab just before the cursor (mirror of
 *                        Tab inserting one); otherwise outdent the block
 *  - with a selection -> outdent every block touched by the selection
 */
export function outdentEditor(editor: Editor): boolean {
  if (editor.isActive("tableCell") || editor.isActive("tableHeader")) {
    return false;
  }
  if (editor.isActive("taskItem")) {
    if (editor.can().liftListItem("taskItem")) {
      editor.chain().focus().liftListItem("taskItem").run();
    }
    return true;
  }
  if (editor.isActive("listItem")) {
    if (editor.can().liftListItem("listItem")) {
      editor.chain().focus().liftListItem("listItem").run();
    }
    return true;
  }
  // Collapsed cursor sitting right after a literal tab: remove it (the inverse
  // of Tab inserting a tab) before falling back to reducing the block indent.
  const { selection } = editor.state;
  if (selection.empty) {
    const pos = selection.from;
    if (pos > 0 && editor.state.doc.textBetween(pos - 1, pos) === "\t") {
      editor.view.dispatch(editor.state.tr.delete(pos - 1, pos));
      return true;
    }
  }
  shiftBlockIndent(editor, -1);
  return true;
}
