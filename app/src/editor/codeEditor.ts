import { type Editor, Extension, type Extensions } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "y-prosemirror";
import { CodeBlock, Document, Text } from "./extensions/baseExtensions.ts";
import { CodeBlockHighlight } from "./extensions/CodeBlockHighlight.ts";

const INDENT = "  ";
const PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "(": ")",
  "[": "]",
  "{": "}",
  "`": "`",
};
const CLOSING = new Set(Object.values(PAIRS));

function codeTextOffset(position: number) {
  // The only child is a codeBlock, whose content starts immediately after the
  // document's opening token.
  return position - 1;
}

function updateSelectedLines(editor: Editor, transform: (line: string) => string) {
  const { state, view } = editor;
  const { from, to } = state.selection;
  const code = state.doc.textContent;
  const start = codeTextOffset(from);
  const end = codeTextOffset(to);
  const lineStart = code.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = code.indexOf("\n", end);
  const endOffset = lineEnd === -1 ? code.length : lineEnd;
  const before = code.slice(lineStart, endOffset);
  const after = before.split("\n").map(transform).join("\n");

  if (before === after) return false;

  const tr = state.tr.insertText(after, lineStart + 1, endOffset + 1);
  view.dispatch(
    tr.setSelection(
      TextSelection.create(tr.doc, tr.mapping.map(from), tr.mapping.map(to)),
    ),
  );
  return true;
}

function indentSelection(editor: Editor) {
  const { state, view } = editor;
  if (state.selection.empty) {
    view.dispatch(state.tr.insertText(INDENT, state.selection.from));
    return true;
  }
  return updateSelectedLines(editor, (line) => `${INDENT}${line}`);
}

function outdentSelection(editor: Editor) {
  return updateSelectedLines(editor, (line) => line.replace(/^(?: {1,2}|\t)/, ""));
}

function newlineWithIndent(editor: Editor) {
  const { state, view } = editor;
  const { from, to } = state.selection;
  const code = state.doc.textContent;
  const offset = codeTextOffset(from);
  const lineStart = code.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const line = code.slice(lineStart, offset);
  const indentation = line.match(/^\s*/)?.[0] ?? "";
  const opensScope = /[[{(]\s*$/.test(line);
  const closesScope = /^\s*[\]})]/.test(code.slice(codeTextOffset(to)));
  const nextIndent = `${indentation}${opensScope ? INDENT : ""}`;
  const inserted = closesScope ? `\n${nextIndent}\n${indentation}` : `\n${nextIndent}`;
  const cursor = from + nextIndent.length + 1;
  const tr = state.tr.insertText(inserted, from, to);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, cursor)));
  return true;
}

function currentLine(editor: Editor) {
  const { state } = editor;
  if (!state.selection.empty) return null;

  const code = state.doc.textContent;
  const offset = codeTextOffset(state.selection.from);
  const lineStart = code.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = code.indexOf("\n", offset);
  const textEnd = lineEnd === -1 ? code.length : lineEnd;
  const deleteStart = lineEnd === -1 && lineStart > 0 ? lineStart - 1 : lineStart;
  const deleteEnd = lineEnd === -1 ? code.length : lineEnd + 1;

  return {
    text: code.slice(lineStart, textEnd) + (lineEnd === -1 ? "" : "\n"),
    from: deleteStart + 1,
    to: deleteEnd + 1,
  };
}

function writeClipboard(text: string) {
  const fallback = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;left:-9999px;opacity:0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };

  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
}

function cutCurrentLine(editor: Editor) {
  const line = currentLine(editor);
  if (!line) return false;

  writeClipboard(line.text);
  const tr = editor.state.tr.delete(line.from, line.to);
  editor.view.dispatch(tr);
  return true;
}

function duplicateCurrentLine(editor: Editor) {
  const line = currentLine(editor);
  if (!line) return false;

  const text = line.text.endsWith("\n") ? line.text : `\n${line.text}`;
  editor.view.dispatch(editor.state.tr.insertText(text, line.to));
  return true;
}

function runUndo(editor: Editor, direction: "undo" | "redo") {
  const undoManager = yUndoPluginKey.getState(editor.state)?.undoManager;
  if (!undoManager) return false;

  if (direction === "undo") {
    if (!undoManager.canUndo()) return false;
    undoManager.undo();
  } else {
    if (!undoManager.canRedo()) return false;
    undoManager.redo();
  }
  return true;
}

const CodeEditing = Extension.create({
  name: "codeEditing",
  priority: 1100,

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            const modKey = event.metaKey || event.ctrlKey;
            const key = event.key.toLowerCase();
            if (modKey && !event.altKey && key === "z") {
              const handled = runUndo(editor, event.shiftKey ? "redo" : "undo");
              if (handled) event.preventDefault();
              return handled;
            }
            if (modKey && !event.altKey && !event.shiftKey && key === "y") {
              const handled = runUndo(editor, "redo");
              if (handled) event.preventDefault();
              return handled;
            }
            if (
              modKey &&
              !event.altKey &&
              !event.shiftKey &&
              key === "d" &&
              editor.state.selection.empty
            ) {
              const duplicated = duplicateCurrentLine(editor);
              if (duplicated) event.preventDefault();
              return duplicated;
            }
            if (
              modKey &&
              !event.altKey &&
              !event.shiftKey &&
              key === "x" &&
              editor.state.selection.empty
            ) {
              const cut = cutCurrentLine(editor);
              if (cut) event.preventDefault();
              return cut;
            }
            return false;
          },
          handleTextInput(view, from, to, text) {
            if (CLOSING.has(text) && from === to) {
              const next = view.state.doc.textBetween(from, from + 1, "\n");
              if (next === text) {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, from + 1),
                  ),
                );
                return true;
              }
            }

            const closing = PAIRS[text];
            if (!closing) return false;

            const selected = view.state.doc.textBetween(from, to, "\n");
            const tr = view.state.tr.insertText(`${text}${selected}${closing}`, from, to);
            const selection = selected
              ? TextSelection.create(tr.doc, from + 1, to + 1)
              : TextSelection.create(tr.doc, from + 1);
            view.dispatch(tr.setSelection(selection));
            return true;
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => newlineWithIndent(this.editor),
      Tab: () => indentSelection(this.editor),
      "Shift-Tab": () => outdentSelection(this.editor),
    };
  },
});

export function codeEditorExtensions(): Extensions {
  return [
    Document.extend({ content: "codeBlock" }),
    Text,
    CodeBlock.configure({ HTMLAttributes: { class: "code-editor-block" } }),
    CodeBlockHighlight,
    CodeEditing,
  ];
}

export function codeEditorContent(code: string, language: string) {
  return {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language },
        ...(code ? { content: [{ type: "text", text: code }] } : {}),
      },
    ],
  };
}
