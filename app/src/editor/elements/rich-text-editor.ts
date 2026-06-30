import { Editor } from "@tiptap/core";
import {
  Bold,
  BulletList,
  Document,
  HardBreak,
  Italic,
  Link,
  ListItem,
  OrderedList,
  Paragraph,
  Text,
} from "../extensions/baseExtensions.ts";
import { messageMarkdownToHtml, tiptapJsonToMarkdown } from "../../utils/messageMarkdown.ts";

if (typeof customElements !== "undefined" && !customElements.get("rich-text-editor")) {
  customElements.define(
    "rich-text-editor",
    class RichTextEditorElement extends HTMLElement {
      private editor: Editor | null = null;
      private lastValue = "";

      connectedCallback() {
        // Like <textarea>, read initial content from child text if the value
        // property wasn't already set programmatically before connect.
        if (!this.lastValue) {
          this.lastValue = this.textContent?.trim() ?? "";
        }
        this.textContent = "";
        this.mountEditor();
      }

      disconnectedCallback() {
        this.editor?.destroy();
        this.editor = null;
      }

      private mountEditor() {
        this.editor = new Editor({
          element: this,
          content: messageMarkdownToHtml(this.lastValue),
          extensions: [
            Document,
            Paragraph,
            Text,
            HardBreak,
            Bold,
            Italic,
            Link,
            BulletList,
            OrderedList,
            ListItem,
          ],
          editorProps: {
            attributes: {
              spellcheck: "false",
            },
            handleDOMEvents: {
              focus: () => {
                this.dispatchEvent(new CustomEvent("editor-focus", { bubbles: true, composed: true }));
                return false;
              },
              blur: () => {
                const value = this.editor ? tiptapJsonToMarkdown(this.editor.getJSON()) : "";
                this.dispatchEvent(
                  new CustomEvent("editor-blur", { detail: value, bubbles: true, composed: true }),
                );
                return false;
              },
            },
          },
          onUpdate: ({ editor }) => {
            const markdown = tiptapJsonToMarkdown(editor.getJSON());
            this.lastValue = markdown;
            this.dispatchEvent(
              new CustomEvent("content-change", { detail: markdown, bubbles: true, composed: true }),
            );
          },
        });
      }

      focus() {
        this.editor?.commands.focus();
      }

      get value(): string {
        return this.lastValue;
      }

      set value(v: string) {
        if (v === this.lastValue) return;
        this.lastValue = v;
        if (!this.editor) return;
        this.editor.commands.setContent(messageMarkdownToHtml(v), { emitUpdate: false });
      }
    },
  );
}
