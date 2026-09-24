import type { Editor } from "@tiptap/core";

let activeEditor: Editor | null = null;

export function setActiveEditor(editor: Editor | null) {
  activeEditor = editor && !editor.isDestroyed ? editor : null;
}

export function getActiveEditor() {
  return activeEditor && !activeEditor.isDestroyed ? activeEditor : null;
}
