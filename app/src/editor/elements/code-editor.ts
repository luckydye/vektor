import { Editor, getSchema } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { prosemirrorToYDoc, relativePositionToAbsolutePosition } from "y-prosemirror";
import * as Y from "yjs";
import { appendCaretDecoration } from "#cosmetics/render.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import { codeEditorContent, codeEditorExtensions } from "#editor/codeEditor.ts";
import {
  colorForPresenceProfile,
  type DocumentPresenceProfile,
  findYSyncState,
} from "#editor/collaboration.ts";
import codeStyles from "#editor/css/code.css?inline";

export interface CodeEditorElementApi extends HTMLElement {
  value: string;
  language: string;
  saving: boolean;
  saved: boolean;
  collaborationDocument: Y.Doc;
  readonly editorInstance: Editor | null;
  appearance: PublicUserAppearance | undefined;
  focus(options?: FocusOptions): void;
  setPresenceProfiles(profiles: DocumentPresenceProfile[]): void;
}

type ProsemirrorMapping = Parameters<typeof relativePositionToAbsolutePosition>[3];

const SHADOW_STYLES = `
  :host {
    --code-editor-font-size: 13px;
    --code-editor-line-height: 20px;
    --code-editor-background: #ffffff;
    --code-editor-foreground: #1f2328;
    --code-editor-gutter-background: #f9f9f9;
    --code-editor-gutter-border: #e8e8e8;
    --code-editor-gutter-foreground: #a0a0a0;
    --code-editor-gutter-active: #3d3d3d;
    --code-editor-selection: #cbacd6;
    --code-editor-caret: #78378f;
    --code-editor-muted: #6e6e6e;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--code-editor-background);
    color: var(--code-editor-foreground);
  }

  @media (prefers-color-scheme: dark) {
    :host {
      --code-editor-background: #151515;
      --code-editor-foreground: #e7e7e7;
      --code-editor-gutter-background: #151515;
      --code-editor-gutter-border: #2f2f2f;
      --code-editor-gutter-foreground: #5a5a5a;
      --code-editor-gutter-active: #cdcdcd;
      --code-editor-selection: #4b3a6d;
      --code-editor-caret: #c099cf;
      --code-editor-muted: #909090;
    }
  }

  :host-context([data-theme="light"]) {
    --code-editor-background: #ffffff;
    --code-editor-foreground: #1f2328;
    --code-editor-gutter-background: #f9f9f9;
    --code-editor-gutter-border: #e8e8e8;
    --code-editor-gutter-foreground: #a0a0a0;
    --code-editor-gutter-active: #3d3d3d;
    --code-editor-selection: #cbacd6;
    --code-editor-caret: #78378f;
    --code-editor-muted: #6e6e6e;
  }

  :host-context([data-theme="dark"]) {
    --code-editor-background: #151515;
    --code-editor-foreground: #e7e7e7;
    --code-editor-gutter-background: #1b1b1b;
    --code-editor-gutter-border: #2f2f2f;
    --code-editor-gutter-foreground: #5a5a5a;
    --code-editor-gutter-active: #cdcdcd;
    --code-editor-selection: #4b3a6d;
    --code-editor-caret: #c099cf;
    --code-editor-muted: #909090;
  }

  .code-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--code-editor-gutter-border);
    background: var(--code-editor-gutter-background);
    color: var(--code-editor-muted);
    font-size: var(--text-size-small, 0.8125rem);
  }

  .code-editor-saved { color: #10b981; }

  .code-editor-body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--code-editor-background);
  }

  .code-editor-gutter {
    flex: none;
    overflow: hidden;
    padding: 12px 8px 12px 12px;
    border-right: 1px solid var(--code-editor-gutter-border);
    background: var(--code-editor-gutter-background);
    color: var(--code-editor-gutter-foreground);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: var(--code-editor-font-size);
    line-height: var(--code-editor-line-height);
    text-align: right;
    user-select: none;
  }

  .code-editor-gutter-line {
    height: var(--code-editor-line-height);
    min-width: 2ch;
    font-variant-numeric: tabular-nums;
  }

  .code-editor-gutter-line.is-active { color: var(--code-editor-gutter-active); }

  .code-editor-surface {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 12px 16px;
    outline: none;
    background: var(--code-editor-background);
    color: var(--code-editor-foreground);
    caret-color: var(--code-editor-caret);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: var(--code-editor-font-size);
    line-height: var(--code-editor-line-height);
    tab-size: 2;
  }

  .code-editor-surface .ProseMirror,
  .code-editor-surface .code-editor-block {
    min-width: max-content;
    min-height: 100%;
    margin: 0;
    outline: none;
    white-space: pre;
  }

  .code-editor-surface .code-editor-block { font: inherit; }

  .code-editor-surface::selection,
  .code-editor-surface ::selection { background: var(--code-editor-selection); }

  .code-editor-presence-layer {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
  }

  .code-editor-presence-cursor {
    position: absolute;
    width: 2px;
    border-radius: 1px;
  }

  .code-editor-presence-selection {
    position: absolute;
    border-radius: 1px;
  }

  .code-editor-presence-label {
    position: absolute;
    bottom: calc(100% + 2px);
    left: -1px;
    max-width: 12rem;
    overflow: hidden;
    padding: 0.125rem 0.25rem;
    border-radius: 0.1875rem;
    color: white;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    font-size: 0.6875rem;
    line-height: 1rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ${codeStyles}
`;

function countLines(code: string) {
  let lines = 1;
  for (const char of code) {
    if (char === "\n") lines += 1;
  }
  return lines;
}

function languageLabel(language: string) {
  return language === "javascript" ? "JavaScript" : language;
}

function codeDocument(code: string, language: string): Y.Doc {
  const schema = getSchema(codeEditorExtensions());
  const document = ProseMirrorNode.fromJSON(schema, codeEditorContent(code, language));
  return prosemirrorToYDoc(document, "default");
}

function setEditorCode(editor: Editor, code: string, language: string) {
  const document = ProseMirrorNode.fromJSON(
    editor.schema,
    codeEditorContent(code, language),
  );
  const tr = editor.state.tr
    .replaceWith(0, editor.state.doc.content.size, document.content)
    // Source supplied through the value property is initialization, never a
    // user edit. y-prosemirror forwards this meta to its UndoManager.
    .setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

function presencePosition(
  editor: Editor,
  ydoc: Y.Doc,
  relative: unknown,
  absolute: unknown,
) {
  const syncState = findYSyncState(editor);
  if (syncState?.binding?.mapping && relative) {
    try {
      const position = relativePositionToAbsolutePosition(
        ydoc,
        syncState.type,
        Y.createRelativePositionFromJSON(relative as never),
        syncState.binding.mapping as ProsemirrorMapping,
      );
      if (typeof position === "number") return position;
    } catch {
      // A remote selection can briefly refer to an already-merged Yjs item.
    }
  }

  if (typeof absolute !== "number" || !Number.isFinite(absolute)) return null;
  const max = Math.max(editor.state.doc.content.size - 1, 1);
  return Math.max(1, Math.min(absolute, max));
}

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("code-editor")
) {
  customElements.define(
    "code-editor",
    class CodeEditorElement extends HTMLElement implements CodeEditorElementApi {
      private editor: Editor | null = null;
      private lastValue = "";
      private ydoc = new Y.Doc();
      private localDocumentSeeded = false;
      private suppressContentChange = false;
      private lineCount = 0;
      private activeLine = 1;
      private presenceProfiles: DocumentPresenceProfile[] = [];
      private localAppearance?: PublicUserAppearance;
      private presenceRenderFrame: number | null = null;
      private readonly shadow: ShadowRoot;
      private readonly languageEl: HTMLSpanElement;
      private readonly statusEl: HTMLSpanElement;
      private readonly bodyEl: HTMLDivElement;
      private readonly gutterEl: HTMLDivElement;
      private readonly surfaceEl: HTMLDivElement;
      private readonly presenceLayer: HTMLDivElement;

      static get observedAttributes() {
        return ["language", "saving", "saved"];
      }

      constructor() {
        super();
        this.shadow = this.attachShadow({ mode: "open" });
        // y-prosemirror expects an EditorView root to expose createRange(). A
        // ShadowRoot exposes getSelection() but not that Document API, so give
        // this editor instance the missing bridge without changing global DOM
        // prototypes.
        const shadowWithRange = this.shadow as ShadowRoot & {
          createRange?: () => Range;
        };
        shadowWithRange.createRange ??= () => document.createRange();
        const style = document.createElement("style");
        style.textContent = SHADOW_STYLES;
        this.shadow.appendChild(style);

        const header = document.createElement("div");
        header.className = "code-editor-header";
        this.languageEl = document.createElement("span");
        this.statusEl = document.createElement("span");
        header.append(this.languageEl, this.statusEl);

        const body = document.createElement("div");
        body.className = "code-editor-body";
        this.bodyEl = body;
        this.gutterEl = document.createElement("div");
        this.gutterEl.className = "code-editor-gutter";
        this.gutterEl.setAttribute("aria-hidden", "true");
        this.surfaceEl = document.createElement("div");
        this.surfaceEl.className = "code-editor-surface code-highlight";
        this.presenceLayer = document.createElement("div");
        this.presenceLayer.className = "code-editor-presence-layer";
        body.append(this.gutterEl, this.surfaceEl, this.presenceLayer);
        this.shadow.append(header, body);
      }

      connectedCallback() {
        if (!this.lastValue) this.lastValue = this.textContent ?? "";
        this.textContent = "";
        if (!this.localDocumentSeeded) {
          this.ydoc = codeDocument(this.lastValue, this.language);
          this.localDocumentSeeded = true;
        }
        this.syncHeader();
        this.mountEditor();
        this.surfaceEl.addEventListener("scroll", this.syncGutterScroll, {
          passive: true,
        });
        window.addEventListener("resize", this.schedulePresenceRender);
      }

      disconnectedCallback() {
        this.surfaceEl.removeEventListener("scroll", this.syncGutterScroll);
        window.removeEventListener("resize", this.schedulePresenceRender);
        if (this.presenceRenderFrame !== null) {
          cancelAnimationFrame(this.presenceRenderFrame);
          this.presenceRenderFrame = null;
        }
        this.editor?.destroy();
        this.editor = null;
      }

      attributeChangedCallback(name: string) {
        if (name === "language" && this.editor) {
          this.editor.commands.updateAttributes("codeBlock", { language: this.language });
        }
        this.syncHeader();
      }

      private mountEditor() {
        this.editor?.destroy();
        this.editor = new Editor({
          element: this.surfaceEl,
          extensions: [
            ...codeEditorExtensions(),
            Collaboration.configure({ document: this.ydoc }),
          ],
          injectCSS: false,
          editorProps: {
            attributes: {
              spellcheck: "false",
              autocorrect: "off",
              autocapitalize: "off",
              translate: "no",
              "aria-label": `${languageLabel(this.language)} editor`,
            },
            handleDOMEvents: {
              focus: () => {
                this.schedulePresenceRender();
                this.dispatchEvent(
                  new CustomEvent("editor-focus", { bubbles: true, composed: true }),
                );
                return false;
              },
              blur: () => {
                this.schedulePresenceRender();
                this.dispatchEvent(
                  new CustomEvent("editor-blur", { bubbles: true, composed: true }),
                );
                return false;
              },
            },
          },
          onUpdate: ({ editor }) => {
            this.lastValue = editor.state.doc.textContent ?? "";
            this.syncGutter();
            this.schedulePresenceRender();
            this.dispatchEvent(
              new CustomEvent("presence-change", { bubbles: true, composed: true }),
            );
            if (this.suppressContentChange) {
              this.suppressContentChange = false;
              return;
            }
            this.dispatchEvent(
              new CustomEvent<string>("content-change", {
                detail: this.lastValue,
                bubbles: true,
                composed: true,
              }),
            );
          },
          onSelectionUpdate: () => {
            this.syncGutter();
            this.schedulePresenceRender();
            this.dispatchEvent(
              new CustomEvent("selection-change", { bubbles: true, composed: true }),
            );
            this.dispatchEvent(
              new CustomEvent("presence-change", { bubbles: true, composed: true }),
            );
          },
        });
        this.lastValue = this.editor.state.doc.textContent;
        this.syncGutter();
        this.schedulePresenceRender();
      }

      private syncHeader() {
        this.languageEl.textContent = languageLabel(this.language);
        this.statusEl.classList.toggle("code-editor-saved", this.saved && !this.saving);
        this.statusEl.textContent = this.saving ? "Saving…" : this.saved ? "Saved" : "";
      }

      private syncGutterScroll = () => {
        this.gutterEl.scrollTop = this.surfaceEl.scrollTop;
        this.schedulePresenceRender();
      };

      private syncGutter() {
        if (!this.editor) return;
        const code = this.editor.state.doc.textContent;
        const lineCount = countLines(code);
        const offset = Math.max(0, this.editor.state.selection.head - 1);
        const activeLine = countLines(code.slice(0, offset));

        if (lineCount !== this.lineCount) {
          const lines = document.createDocumentFragment();
          for (let line = 1; line <= lineCount; line++) {
            const element = document.createElement("div");
            element.className = "code-editor-gutter-line";
            element.textContent = String(line);
            lines.appendChild(element);
          }
          this.gutterEl.replaceChildren(lines);
          this.lineCount = lineCount;
          this.activeLine = 0;
        }

        if (activeLine !== this.activeLine) {
          this.gutterEl.children.item(this.activeLine - 1)?.classList.remove("is-active");
          this.gutterEl.children.item(activeLine - 1)?.classList.add("is-active");
          this.activeLine = activeLine;
        }
      }

      private schedulePresenceRender = () => {
        if (this.presenceRenderFrame !== null) return;
        this.presenceRenderFrame = requestAnimationFrame(() => {
          this.presenceRenderFrame = null;
          this.renderPresence();
        });
      };

      private renderPresence() {
        this.presenceLayer.replaceChildren();
        const editor = this.editor;
        if (!editor) return;

        const bodyRect = this.bodyEl.getBoundingClientRect();
        const surfaceRect = this.surfaceEl.getBoundingClientRect();
        for (const profile of this.presenceProfiles) {
          const state = profile.state;
          const selection = state?.focused ? state.selection : null;
          if (!selection) continue;

          const position = presencePosition(
            editor,
            this.ydoc,
            selection.head,
            selection.absoluteHead,
          );
          if (position === null) continue;

          try {
            const color = colorForPresenceProfile(profile);
            const anchor = presencePosition(
              editor,
              this.ydoc,
              selection.anchor,
              selection.absoluteAnchor,
            );
            if (anchor !== null && anchor !== position) {
              for (const rect of this.presenceSelectionRects(anchor, position)) {
                const selectionOverlay = document.createElement("div");
                selectionOverlay.className = "code-editor-presence-selection";
                selectionOverlay.style.backgroundColor = `${color}30`;
                selectionOverlay.style.left = `${this.surfaceEl.offsetLeft + rect.left - surfaceRect.left}px`;
                selectionOverlay.style.top = `${rect.top - bodyRect.top}px`;
                selectionOverlay.style.width = `${rect.width}px`;
                selectionOverlay.style.height = `${rect.height}px`;
                this.presenceLayer.appendChild(selectionOverlay);
              }
            }

            const coordinates = editor.view.coordsAtPos(position);
            const cursor = document.createElement("div");
            cursor.className = "code-editor-presence-cursor";
            cursor.style.backgroundColor = color;
            cursor.style.left = `${this.surfaceEl.offsetLeft + coordinates.left - surfaceRect.left}px`;
            cursor.style.top = `${coordinates.top - bodyRect.top}px`;
            cursor.style.height = `${Math.max(coordinates.bottom - coordinates.top, 1)}px`;

            const label = document.createElement("span");
            label.className = "code-editor-presence-label";
            label.style.backgroundColor = color;
            label.textContent = profile.user.name;
            cursor.appendChild(label);
            appendCaretDecoration(cursor, profile.user.appearance);
            this.presenceLayer.appendChild(cursor);
          } catch {
            // The remote position may have become stale between the Yjs update
            // and measuring it in the ProseMirror view.
          }
        }

        if (editor.isFocused && this.localAppearance?.caret) {
          try {
            const coordinates = editor.view.coordsAtPos(editor.state.selection.head);
            const cursor = document.createElement("div");
            cursor.className = "code-editor-presence-cursor";
            cursor.style.left = `${this.surfaceEl.offsetLeft + coordinates.left - surfaceRect.left}px`;
            cursor.style.top = `${coordinates.top - bodyRect.top}px`;
            cursor.style.height = `${Math.max(coordinates.bottom - coordinates.top, 1)}px`;
            appendCaretDecoration(cursor, this.localAppearance);
            this.presenceLayer.appendChild(cursor);
          } catch {
            // The editor may be remounting while the local selection is measured.
          }
        }
      }

      private presenceSelectionRects(anchor: number, head: number) {
        const view = this.editor?.view;
        if (!view) return [];

        try {
          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          const start = view.domAtPos(from);
          const end = view.domAtPos(to);
          const range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          const lines: Array<{
            left: number;
            top: number;
            right: number;
            bottom: number;
          }> = [];
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width <= 0 || rect.height <= 0) continue;

            const line = lines.find(
              (candidate) =>
                Math.abs(candidate.top - rect.top) < 1 &&
                Math.abs(candidate.bottom - rect.bottom) < 1,
            );
            if (line) {
              line.left = Math.min(line.left, rect.left);
              line.right = Math.max(line.right, rect.right);
            } else {
              lines.push({
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
              });
            }
          }

          return lines.map((line) => ({
            left: line.left,
            top: line.top,
            width: line.right - line.left,
            height: line.bottom - line.top,
          }));
        } catch {
          return [];
        }
      }

      focus(options?: FocusOptions) {
        this.editor?.commands.focus(undefined, {
          scrollIntoView: !options?.preventScroll,
        });
      }

      get editorInstance() {
        return this.editor;
      }

      setPresenceProfiles(profiles: DocumentPresenceProfile[]) {
        this.presenceProfiles = profiles;
        this.schedulePresenceRender();
      }

      get appearance() {
        return this.localAppearance;
      }

      set appearance(value: PublicUserAppearance | undefined) {
        this.localAppearance = value;
        this.surfaceEl.style.caretColor = value?.caret ? "transparent" : "";
        this.schedulePresenceRender();
      }

      get value() {
        return this.lastValue;
      }

      set value(value: string) {
        if (value === this.lastValue) return;
        this.lastValue = value;
        if (!this.editor) return;
        this.suppressContentChange = true;
        setEditorCode(this.editor, value, this.language);
      }

      get collaborationDocument() {
        return this.ydoc;
      }

      set collaborationDocument(ydoc: Y.Doc) {
        if (!(ydoc instanceof Y.Doc) || ydoc === this.ydoc) return;
        this.ydoc = ydoc;
        this.localDocumentSeeded = true;
        if (this.isConnected) this.mountEditor();
      }

      get language() {
        return this.getAttribute("language") || "javascript";
      }

      set language(value: string) {
        this.setAttribute("language", value);
      }

      get saving() {
        return (
          this.getAttribute("saving") !== null && this.getAttribute("saving") !== "false"
        );
      }

      set saving(value: boolean) {
        this.toggleAttribute("saving", value);
      }

      get saved() {
        return (
          this.getAttribute("saved") !== null && this.getAttribute("saved") !== "false"
        );
      }

      set saved(value: boolean) {
        this.toggleAttribute("saved", value);
      }
    },
  );
}
