import type { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import {
  messageMarkdownToHtml,
  tiptapJsonToMarkdown,
} from "../../utils/messageMarkdown.ts";
import { createBaseEditor } from "../extensions.ts";

export type RichTextEditorFormat = "bold" | "italic" | "bulletList" | "orderedList";

type FormatCommandChain = {
  toggleBold(): { run(): boolean };
  toggleItalic(): { run(): boolean };
  toggleBulletList(): { run(): boolean };
  toggleOrderedList(): { run(): boolean };
};

export interface RichTextEditorElementApi extends HTMLElement {
  value: string;
  readonly el: HTMLElement | null;
  focus(): void;
  isActive(name: string): boolean;
  toggleFormat(name: RichTextEditorFormat): void;
  getSelectionContext(): { caret: number; beforeCaret: string } | null;
  insertMention(start: number, end: number, title: string, id: string): void;
}

const SHADOW_STYLES = `
  /* ProseMirror baseline — replaces TipTap's document-head injection */
  .ProseMirror {
    position: relative;
    word-wrap: break-word;
    -webkit-font-variant-ligatures: none;
    font-variant-ligatures: none;
    font-feature-settings: "liga" 0;
    overflow-wrap: var(--editor-overflow-wrap, break-word);
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
    min-height: var(--editor-min-height, 0);
    padding: var(--editor-padding, 0);
    white-space: var(--editor-white-space, normal);
    word-break: var(--editor-word-break, normal);
  }

  .tiptap p.is-editor-empty:first-child::before {
    color: var(--editor-placeholder-color, var(--color-neutral-400, #9ca3af));
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }

  .tiptap p { margin: 0; }
  .tiptap ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
  .tiptap ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
  .tiptap li { display: list-item; margin: 0.125rem 0; }
  .tiptap li > p { display: inline; }
`;

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("rich-text-editor")
) {
  customElements.define(
    "rich-text-editor",
    class RichTextEditorElement extends HTMLElement implements RichTextEditorElementApi {
      private editor: Editor | null = null;
      private lastValue = "";
      private shadow: ShadowRoot;
      private _mount: HTMLDivElement;

      static get observedAttributes() {
        return ["placeholder"];
      }

      constructor() {
        super();
        this.shadow = this.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = SHADOW_STYLES;
        this.shadow.appendChild(style);
        this._mount = document.createElement("div");
        this._mount.style.cssText = "display:contents";
        this.shadow.appendChild(this._mount);
      }

      attributeChangedCallback(name: string) {
        if (name === "placeholder") {
          this.syncEditorAttributes();
        }
      }

      connectedCallback() {
        // Like <textarea>, read initial content from child text if the value
        // property wasn't already set programmatically before connect.
        if (!this.lastValue) {
          this.lastValue = this.textContent?.trim() ?? "";
        }
        this.textContent = "";
        this.mountEditor();
        this.addEventListener("pointerdown", this._onPointerDown);
      }

      disconnectedCallback() {
        this.removeEventListener("pointerdown", this._onPointerDown);
        this.editor?.destroy();
        this.editor = null;
      }

      // When the editor is not yet focused, prevent mousedown from reaching
      // ProseMirror (which would start text-selection tracking). Instead,
      // detect click vs drag ourselves and only focus on a clean click.
      private _onPointerDown = (event: PointerEvent) => {
        if (this.editor?.isFocused) return;

        // Suppressing pointerdown's default prevents the browser from firing
        // the corresponding mousedown, which ProseMirror uses to start
        // selection tracking — so dragging the shape won't select text.
        event.preventDefault();

        const startX = event.clientX;
        const startY = event.clientY;
        let dragged = false;

        const onMove = (e: PointerEvent) => {
          if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
            dragged = true;
            window.removeEventListener("pointermove", onMove);
          }
        };

        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (!dragged) this.editor?.commands.focus();
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      };

      private get placeholderText() {
        return this.getAttribute("placeholder") ?? "";
      }

      private syncEditorAttributes() {
        if (!this.editor) return;
        this.editor.view.dom.setAttribute("data-placeholder", this.placeholderText);
      }

      private mountEditor() {
        this.editor = createBaseEditor({
          element: this._mount,
          content: messageMarkdownToHtml(this.lastValue),
          injectCSS: false,
          extensions: [Placeholder.configure({ placeholder: this.placeholderText })],
          editorProps: {
            attributes: {
              "data-placeholder": this.placeholderText,
              spellcheck: "false",
            },
            handlePaste: (_view, event) => {
              this.dispatchEvent(
                new CustomEvent("editor-paste", {
                  detail: event,
                  bubbles: true,
                  composed: true,
                }),
              );
              return event.defaultPrevented;
            },
            handleDOMEvents: {
              // Stop keyboard events from bubbling out of the shadow so
              // canvas-level shortcuts (Delete, Escape, etc.) don't fire
              // while the user is typing.
              keydown: (_view, event) => {
                this.dispatchEvent(
                  new CustomEvent("editor-keydown", {
                    detail: event,
                    bubbles: true,
                    composed: true,
                  }),
                );
                event.stopPropagation();
                return event.defaultPrevented;
              },
              keyup: (_view, event) => {
                this.dispatchEvent(
                  new CustomEvent("editor-keyup", {
                    detail: event,
                    bubbles: true,
                    composed: true,
                  }),
                );
                event.stopPropagation();
                return false;
              },
              click: (_view, event) => {
                this.dispatchEvent(
                  new CustomEvent("editor-click", {
                    detail: event,
                    bubbles: true,
                    composed: true,
                  }),
                );
                return false;
              },
              focus: () => {
                this.dispatchEvent(
                  new CustomEvent("editor-focus", { bubbles: true, composed: true }),
                );
                return false;
              },
              blur: () => {
                const value = this.editor
                  ? tiptapJsonToMarkdown(this.editor.getJSON())
                  : "";
                this.dispatchEvent(
                  new CustomEvent("editor-blur", {
                    detail: value,
                    bubbles: true,
                    composed: true,
                  }),
                );
                return false;
              },
            },
          },
          onUpdate: ({ editor }) => {
            const markdown = tiptapJsonToMarkdown(editor.getJSON());
            this.lastValue = markdown;
            this.dispatchEvent(
              new CustomEvent("content-change", {
                detail: markdown,
                bubbles: true,
                composed: true,
              }),
            );
          },
        });
      }

      focus() {
        this.editor?.commands.focus();
      }

      isActive(name: string) {
        return this.editor?.isActive(name) ?? false;
      }

      toggleFormat(name: RichTextEditorFormat) {
        if (!this.editor) return;
        const chain = this.editor.chain().focus() as unknown as FormatCommandChain;
        if (name === "bold") chain.toggleBold().run();
        if (name === "italic") chain.toggleItalic().run();
        if (name === "bulletList") chain.toggleBulletList().run();
        if (name === "orderedList") chain.toggleOrderedList().run();
      }

      getSelectionContext() {
        if (!this.editor) return null;
        const caret = this.editor.state.selection.from;
        return {
          caret,
          beforeCaret: this.editor.state.doc.textBetween(0, caret, "\n", "\n"),
        };
      }

      insertMention(start: number, end: number, title: string, id: string) {
        this.editor
          ?.chain()
          .focus()
          .insertContentAt({ from: start, to: end }, [
            { type: "text", text: "@" },
            {
              type: "text",
              text: title,
              marks: [{ type: "link", attrs: { href: `doc:${id}` } }],
            },
            { type: "text", text: " " },
          ])
          .run();
      }

      get el() {
        return this.editor?.view.dom ?? null;
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
