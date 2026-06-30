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

const SHADOW_STYLES = `
  /* ProseMirror baseline — replaces TipTap's document-head injection */
  .ProseMirror {
    position: relative;
    word-wrap: break-word;
    -webkit-font-variant-ligatures: none;
    font-variant-ligatures: none;
    font-feature-settings: "liga" 0;
  }
  .ProseMirror-hideselection *::selection { background: transparent; }
  .ProseMirror-hideselection *::-moz-selection { background: transparent; }
  .ProseMirror-hideselection { caret-color: transparent; }

  /* Editor element (.tiptap.ProseMirror) */
  .tiptap {
    box-sizing: border-box;
    width: 100%;
    border: 0;
    background: transparent;
    outline: none;
    overflow: hidden;
    -webkit-user-select: text;
    user-select: text;
    padding: var(--editor-padding, 0);
    white-space: var(--editor-white-space, normal);
    word-break: var(--editor-word-break, normal);
  }

  .tiptap p { margin: 0; }
  .tiptap ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
  .tiptap ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
  .tiptap li { display: list-item; margin: 0.125rem 0; }
  .tiptap li > p { display: inline; }
`;

if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined" && !customElements.get("rich-text-editor")) {
  customElements.define(
    "rich-text-editor",
    class RichTextEditorElement extends HTMLElement {
      private editor: Editor | null = null;
      private lastValue = "";
      private shadow: ShadowRoot;

      constructor() {
        super();
        this.shadow = this.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = SHADOW_STYLES;
        this.shadow.appendChild(style);
      }

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
          element: this.shadow as unknown as HTMLElement,
          content: messageMarkdownToHtml(this.lastValue),
          injectCSS: false,
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
