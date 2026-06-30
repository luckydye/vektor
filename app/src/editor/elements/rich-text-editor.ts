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

      static get observedAttributes() {
        return ["value"];
      }

      connectedCallback() {
        this.lastValue = this.getAttribute("value") ?? "";
        this.mountEditor();
      }

      disconnectedCallback() {
        this.editor?.destroy();
        this.editor = null;
      }

      attributeChangedCallback(name: string, _old: string, newValue: string) {
        if (name === "value") {
          const v = newValue ?? "";
          if (!this.editor || v === this.lastValue) return;
          this.lastValue = v;
          this.editor.commands.setContent(messageMarkdownToHtml(v), { emitUpdate: false });
        }
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
        if (!this.editor || v === this.lastValue) return;
        this.lastValue = v;
        this.editor.commands.setContent(messageMarkdownToHtml(v), { emitUpdate: false });
      }
    },
  );
}
