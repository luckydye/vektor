import { type Editor, Extension } from "@tiptap/core";
import { Heading } from "#editor/extensions/baseExtensions.ts";
import {
  isMentionSuggestionOpen,
  MentionSuggestions,
} from "#editor/extensions/MentionSuggestions.ts";
import { Placeholder } from "#editor/extensions/Placeholder.ts";
import { createBaseEditor } from "#editor/extensions.ts";
import { messageMarkdownToHtml, tiptapJsonToMarkdown } from "#utils/messageMarkdown.ts";

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
  readonly editorInstance: Editor | null;
  focus(options?: FocusOptions): void;
  isActive(name: string): boolean;
  isMentionSuggestionOpen(): boolean;
  toggleFormat(name: RichTextEditorFormat): void;
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

  /* Don't paint the text selection while the editor is unfocused — blurring a
     canvas text node keeps its ProseMirror selection, and the browser would
     otherwise leave the highlight visible after you click away. */
  .tiptap:not(:focus) ::selection { background: transparent; }
  .tiptap:not(:focus) ::-moz-selection { background: transparent; }
  .tiptap:not(:focus)::selection { background: transparent; }
  .tiptap:not(:focus)::-moz-selection { background: transparent; }

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
  .tiptap h1, .tiptap h2, .tiptap h3, .tiptap h4 {
    margin: 0;
    font-weight: 700;
    line-height: 1.2;
  }
  .tiptap h1 { font-size: 1.75em; }
  .tiptap h2 { font-size: 1.4em; }
  .tiptap h3 { font-size: 1.2em; }
  .tiptap h4 { font-size: 1.05em; }
  .tiptap ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
  .tiptap ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
  .tiptap li { display: list-item; margin: 0.125rem 0; }
  .tiptap li > p { display: inline; }
  .tiptap user-mention {
    background: var(--color-primary-50, #d6bfde);
    border: 1px solid var(--color-primary-200, #c099cf);
    border-radius: 0.25rem;
    color: var(--color-primary-700, #78378f);
    cursor: pointer;
    font-weight: 500;
    padding: 0 0.25rem;
  }
  .tiptap user-mention:hover {
    background: var(--color-primary-100, #cbacd6);
    border-color: var(--color-primary-300, #b686c8);
  }
  .tiptap user-mention[data-self-mention="true"] {
    background: var(--color-primary-100, #cbacd6);
    border-color: var(--color-primary-300, #b686c8);
    color: var(--color-primary-800, #562567);
  }
  .tiptap user-mention[data-self-mention="true"]:hover {
    background: var(--color-primary-200, #c099cf);
    border-color: var(--color-primary-400, #ac72c1);
  }
  .tiptap document-mention,
  .tiptap a[href^="doc:"],
  .tiptap a[href*="/doc/"] {
    background: var(--color-neutral-50, #f9f9f9);
    border: 1px solid var(--color-neutral-200, #e5e7eb);
    border-radius: 0.375rem;
    color: var(--color-primary-700, #6d28d9);
    cursor: default;
    font-weight: 500;
    padding: 0.0625rem 0.3125rem;
    text-decoration: none;
    white-space: nowrap;
  }
  .tiptap document-mention:hover,
  .tiptap a[href^="doc:"]:hover,
  .tiptap a[href*="/doc/"]:hover {
    background: var(--color-primary-50, #d6bfde);
    border-color: var(--color-primary-200, #c099cf);
  }
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
        return [
          "placeholder",
          "mentions",
          "inline-document-references",
          "space-id",
          "document-id",
        ];
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
          return;
        }
        if (!this.editor) return;
        this.editor.destroy();
        this.editor = null;
        this.mountEditor();
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

      private get headingsEnabled() {
        return this.hasAttribute("headings");
      }

      private get mentionsEnabled() {
        return this.hasAttribute("mentions") && Boolean(this.getAttribute("space-id"));
      }

      private get inlineDocumentReferencesEnabled() {
        return this.hasAttribute("inline-document-references");
      }

      private mountEditor() {
        const headingsEnabled = this.headingsEnabled;

        // The custom base marks don't ship keyboard shortcuts (the document
        // editor binds them through an app-level Actions registry, which the
        // canvas/chat editors don't use). Bind the common ones here so Cmd+B
        // etc. work in a standalone rich-text-editor.
        const KeyboardShortcuts = Extension.create({
          name: "richTextKeyboardShortcuts",
          addKeyboardShortcuts() {
            const shortcuts: Record<string, () => boolean> = {
              "Mod-b": () => this.editor.chain().focus().toggleBold().run(),
              "Mod-i": () => this.editor.chain().focus().toggleItalic().run(),
              "Mod-Shift-8": () => this.editor.chain().focus().toggleBulletList().run(),
              "Mod-Shift-7": () => this.editor.chain().focus().toggleOrderedList().run(),
            };
            if (headingsEnabled) {
              for (const level of [1, 2, 3, 4] as const) {
                shortcuts[`Mod-Alt-${level}`] = () =>
                  this.editor.chain().focus().toggleHeading({ level }).run();
              }
            }
            return shortcuts;
          },
        });

        this.editor = createBaseEditor({
          element: this._mount,
          content: messageMarkdownToHtml(this.lastValue),
          injectCSS: false,
          extensions: [
            Placeholder.configure({ placeholder: this.placeholderText }),
            KeyboardShortcuts,
            // Opt-in (canvas text/notes): enables the `## `→H2 markdown input
            // rule and heading nodes. Chat input leaves this off.
            ...(headingsEnabled ? [Heading.configure({ levels: [1, 2, 3, 4] })] : []),
            ...(this.mentionsEnabled
              ? [
                  MentionSuggestions.configure({
                    spaceId: this.getAttribute("space-id") ?? "",
                    documentId: this.getAttribute("document-id") ?? undefined,
                    inlineDocumentReferences: this.inlineDocumentReferencesEnabled,
                  }),
                ]
              : []),
          ],
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

      focus(options?: FocusOptions) {
        this.editor?.commands.focus(undefined, {
          scrollIntoView: !options?.preventScroll,
        });
      }

      isActive(name: string) {
        return this.editor?.isActive(name) ?? false;
      }

      isMentionSuggestionOpen() {
        return isMentionSuggestionOpen(this.editor);
      }

      toggleFormat(name: RichTextEditorFormat) {
        if (!this.editor) return;
        const chain = this.editor.chain().focus() as unknown as FormatCommandChain;
        if (name === "bold") chain.toggleBold().run();
        if (name === "italic") chain.toggleItalic().run();
        if (name === "bulletList") chain.toggleBulletList().run();
        if (name === "orderedList") chain.toggleOrderedList().run();
      }

      get el() {
        return this.editor?.view.dom ?? null;
      }

      // Exposes the underlying TipTap editor so a shared formatting toolbar
      // (see <document-toolbar variant="canvas">) can issue commands against it.
      get editorInstance() {
        return this.editor;
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
