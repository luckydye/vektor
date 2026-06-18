import { editing } from "../composeables/useEditor.ts";
import docStyles from "../styles/document.css?inline";
import "./elements/textarea.ts";
import "./elements/expression.ts";
import "./elements/file-attachment.ts";
import "./elements/document-attachment.ts";
import { Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import DragHandle from "@tiptap/extension-drag-handle";
import { Dropcursor } from "@tiptap/extensions";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import * as Y from "yjs";
import {
  colorForPresenceProfile,
  type DocumentPresenceProfile,
  findYSyncState,
} from "./collaboration.ts";
import { ExtensionSuggestions } from "./extensions/ExtensionSuggestions.ts";
import {
  imageFilesFromDataTransfer,
  insertImageFilesAt,
} from "./extensions/ImageUpload.ts";
import { InlineSuggestions } from "./extensions/InlineSuggestions.ts";
import { MentionSuggestons } from "./extensions/MentionSuggestons.ts";
import { TrailingNodePlus } from "./extensions/TrailingNodePlus.ts";
import { contentExtensions, type EditorContext } from "./extensions.ts";

declare global {
  interface Window {
    __editor?: Editor;
  }
}

const documentPresencePluginKey = new PluginKey<DocumentPresenceProfile[]>(
  "document-presence",
);

function dragHasFiles(transfer: DataTransfer | null) {
  if (!transfer) return false;
  if (Array.from(transfer.types).includes("Files")) return true;
  return Array.from(transfer.items || []).some((item) => item.kind === "file");
}

function relativePresencePositionToAbsolute(
  state: EditorState,
  ydoc: Y.Doc,
  position: unknown,
) {
  const syncState = findYSyncState(state);
  const mapping = syncState?.binding?.mapping;
  if (!mapping || !position) {
    return null;
  }

  try {
    const relativePosition = Y.createRelativePositionFromJSON(position as never);
    return relativePositionToAbsolutePosition(
      ydoc,
      syncState.type,
      relativePosition,
      mapping,
    );
  } catch {
    return null;
  }
}

function createPresenceWidget(profile: DocumentPresenceProfile, color: string) {
  const caret = document.createElement("span");
  caret.className = "collaboration-carets__caret";
  caret.style.borderColor = color;

  const label = document.createElement("span");
  label.className = "collaboration-carets__label";
  label.style.backgroundColor = color;
  label.textContent = profile.user.name || "User";
  caret.append(label);

  return caret;
}

function createDocumentPresenceExtension(ydoc: Y.Doc) {
  return Extension.create({
    name: "documentPresence",

    addProseMirrorPlugins() {
      return [
        new Plugin<DocumentPresenceProfile[]>({
          key: documentPresencePluginKey,
          state: {
            init: () => [],
            apply(transaction, value) {
              const next = transaction.getMeta(documentPresencePluginKey);
              return Array.isArray(next) ? next : value;
            },
          },
          props: {
            decorations(state) {
              const profiles = documentPresencePluginKey.getState(state) ?? [];
              const decorations: Decoration[] = [];

              for (const profile of profiles) {
                if (profile.state?.kind !== "editor" || !profile.state.selection) {
                  continue;
                }

                const anchor = relativePresencePositionToAbsolute(
                  state,
                  ydoc,
                  profile.state.selection.anchor,
                );
                const head = relativePresencePositionToAbsolute(
                  state,
                  ydoc,
                  profile.state.selection.head,
                );
                if (anchor === null || head === null) continue;

                const maxPos = Math.max(state.doc.content.size - 1, 0);
                const from = Math.max(0, Math.min(anchor, head, maxPos));
                const to = Math.max(0, Math.min(Math.max(anchor, head), maxPos));
                const color = colorForPresenceProfile(profile);

                if (from !== to) {
                  decorations.push(
                    Decoration.inline(
                      from,
                      to,
                      {
                        class: "ProseMirror-yjs-selection",
                        style: `background-color: ${color}70;`,
                      },
                      { inclusiveStart: false, inclusiveEnd: true },
                    ),
                  );
                }

                decorations.push(
                  Decoration.widget(
                    Math.max(0, Math.min(head, maxPos)),
                    () => createPresenceWidget(profile, color),
                    { side: 10, key: `presence:${profile.clientId}` },
                  ),
                );
              }

              return DecorationSet.create(state.doc, decorations);
            },
          },
        }),
      ];
    },
  });
}

function createEditor(
  editorElement: HTMLElement,
  ydoc: Y.Doc,
  context: EditorContext = {},
  html?: string,
) {
  // const _persitance = new IndexeddbPersistence(roomName, ydoc);
  let lastPointerX = 0;
  let lastPointerY = 0;
  let hasPointerPosition = false;
  let blockDropIndicator: HTMLDivElement | null = null;
  let dragHandleElement: HTMLElement | null = null;

  let editor: Editor;

  const trackPointerPosition = (clientX: number, clientY: number) => {
    lastPointerX = clientX;
    lastPointerY = clientY;
    hasPointerPosition = true;
  };

  const handleTrackedPointerMove = (event: MouseEvent | PointerEvent) => {
    trackPointerPosition(event.clientX, event.clientY);
  };

  const isPointInsideRect = (clientX: number, clientY: number, rect: DOMRect) => {
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  };

  const clearTrackedPointerPosition = (event?: MouseEvent | PointerEvent) => {
    const nextTarget = event?.relatedTarget;
    if (
      nextTarget instanceof Node &&
      (editor?.view?.dom?.contains(nextTarget) || dragHandleElement?.contains(nextTarget))
    ) {
      return;
    }

    hasPointerPosition = false;
    editor?.commands.setMeta("hideDragHandle", true);
  };

  const syncDragHandlePosition = () => {
    if (!hasPointerPosition || !editor?.view?.dom) return;
    const pointerInsideEditor = isPointInsideRect(
      lastPointerX,
      lastPointerY,
      editor.view.dom.getBoundingClientRect(),
    );
    const pointerInsideHandle =
      !!dragHandleElement &&
      isPointInsideRect(
        lastPointerX,
        lastPointerY,
        dragHandleElement.getBoundingClientRect(),
      );

    if (!pointerInsideEditor && !pointerInsideHandle) {
      clearTrackedPointerPosition();
      return;
    }

    // Force drag-handle plugin to forget current node so same-node scroll updates reposition.
    editor.commands.setMeta("hideDragHandle", true);

    editor.view.dom.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: lastPointerX,
        clientY: lastPointerY,
        view: window,
      }),
    );
  };

  const cleanupDragHandleSync = () => {
    editor?.view?.dom?.removeEventListener("mousemove", handleTrackedPointerMove);
    editor?.view?.dom?.removeEventListener("mouseleave", clearTrackedPointerPosition);
    dragHandleElement?.removeEventListener("pointermove", handleTrackedPointerMove);
    dragHandleElement?.removeEventListener("pointerleave", clearTrackedPointerPosition);
    window.removeEventListener("scroll", syncDragHandlePosition, true);
    window.removeEventListener("resize", syncDragHandlePosition, true);
  };

  const isInlineSuggestionElement = (target: EventTarget | null) => {
    return target instanceof HTMLElement && target.closest(".wiki-inline-suggestion");
  };

  const ensureBlockDropIndicator = () => {
    if (blockDropIndicator) return blockDropIndicator;

    const indicator = document.createElement("div");
    indicator.className = "wiki-block-drop-indicator";
    Object.assign(indicator.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "2px",
      borderRadius: "var(--radius-full)",
      backgroundColor: "var(--color-primary-500, #3b82f6)",
      boxShadow:
        "0 0 0 1px color-mix(in srgb, var(--color-primary-500, #3b82f6) 25%, transparent)",
      pointerEvents: "none",
      opacity: "0",
      zIndex: "10000",
    });
    document.body.appendChild(indicator);
    blockDropIndicator = indicator;
    return indicator;
  };

  const hideBlockDropIndicator = () => {
    if (!blockDropIndicator) return;
    blockDropIndicator.style.opacity = "0";
    blockDropIndicator.style.width = "0";
  };

  const getTopLevelBlockAtPoint = (
    clientX: number,
    clientY: number,
  ): HTMLElement | null => {
    const root = editor.view.root as Document | ShadowRoot;
    const elements = root.elementsFromPoint(clientX, clientY);

    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      if (!editor.view.dom.contains(element)) continue;
      if (element.closest(".wiki-inline-suggestion")) continue;

      const columnItem = element.closest<HTMLElement>('div[data-type="column-item"]');
      if (columnItem && editor.view.dom.contains(columnItem)) {
        let current: HTMLElement | null = element;
        while (current?.parentElement && current.parentElement !== columnItem) {
          current = current.parentElement;
        }

        if (current?.parentElement === columnItem) {
          return current;
        }

        return columnItem;
      }

      let current: HTMLElement | null = element;
      while (current?.parentElement && current.parentElement !== editor.view.dom) {
        current = current.parentElement;
      }

      if (current?.parentElement === editor.view.dom) {
        return current;
      }
    }

    return null;
  };

  const updateBlockDropIndicator = (event: DragEvent) => {
    if (!editor.isEditable) return;

    const block = getTopLevelBlockAtPoint(event.clientX, event.clientY);
    if (!block) {
      hideBlockDropIndicator();
      return;
    }

    const rect = block.getBoundingClientRect();
    const isTopHalf = event.clientY < rect.top + rect.height / 2;
    const lineY = isTopHalf ? rect.top : rect.bottom;
    const indicator = ensureBlockDropIndicator();

    indicator.style.left = `${Math.round(rect.left)}px`;
    indicator.style.top = `${Math.round(lineY - 1)}px`;
    indicator.style.width = `${Math.round(rect.width)}px`;
    indicator.style.opacity = "1";
  };

  const handleEditorMouseMove = (event: MouseEvent) => {
    if (!isInlineSuggestionElement(event.target)) {
      return;
    }

    editor.commands.setMeta("hideDragHandle", true);
    hideBlockDropIndicator();
  };

  const handleEditorDragOver = (event: DragEvent) => {
    if (isInlineSuggestionElement(event.target)) {
      hideBlockDropIndicator();
      return;
    }

    if (dragHasFiles(event.dataTransfer)) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    }

    updateBlockDropIndicator(event);
  };

  const cleanupBlockDropIndicator = () => {
    editor?.view?.dom?.removeEventListener("mousemove", handleEditorMouseMove);
    editor?.view?.dom?.removeEventListener("dragover", handleEditorDragOver);
    editor?.view?.dom?.removeEventListener("drop", hideBlockDropIndicator);
    window.removeEventListener("dragend", hideBlockDropIndicator, true);

    if (blockDropIndicator) {
      blockDropIndicator.remove();
      blockDropIndicator = null;
    }
  };

  window.addEventListener("scroll", syncDragHandlePosition, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", syncDragHandlePosition, {
    capture: true,
    passive: true,
  });

  editor = new Editor({
    element: editorElement,
    enableCoreExtensions: true,
    content: html,
    onContentError: ({ error, disableCollaboration }) => {
      console.error(error);
      disableCollaboration();
    },
    onCreate: async ({ editor: currentEditor }) => {
      currentEditor.commands.focus();
    },
    onUpdate: () => {},
    onDestroy: () => {
      cleanupDragHandleSync();
      cleanupBlockDropIndicator();
    },
    extensions: [
      ...contentExtensions(context),

      TrailingNodePlus.configure({
        spaceId: context.spaceId ?? "",
        documentId: context.documentId,
      }),

      DragHandle.configure({
        computePositionConfig: {
          strategy: "fixed",
        },
        render: () => {
          const element = document.createElement("div");
          element.classList.add("custom-drag-handle");
          dragHandleElement = element;
          return element;
        },
        onNodeChange: ({ node, pos }) => {
          if (!node) return;
          const { doc } = editor.state;
          const isTrailingNode =
            node.type.name === "paragraph" &&
            node.content.size === 0 &&
            pos + node.nodeSize === doc.content.size;
          if (isTrailingNode) {
            editor.commands.setMeta("hideDragHandle", true);
          }
        },
        onElementDragEnd: () => {
          // Reset plugin state after a drag so handle can reappear on the same block.
          editor.commands.setMeta("hideDragHandle", true);
        },
      }),
      Dropcursor.configure({
        color: "var(--color-primary-500)",
        width: 2,
        class: "wiki-dropcursor",
      }),
      MentionSuggestons.configure({
        spaceId: context.spaceId ?? "",
        documentId: context.documentId,
      }),

      ExtensionSuggestions,
      InlineSuggestions,

      Collaboration.configure({
        document: ydoc,
      }),

      createDocumentPresenceExtension(ydoc),
    ],
  });

  editor.view.dom.addEventListener("mousemove", handleEditorMouseMove);
  editor.view.dom.addEventListener("mousemove", handleTrackedPointerMove, {
    passive: true,
  });
  editor.view.dom.addEventListener("mouseleave", clearTrackedPointerPosition);
  editor.view.dom.addEventListener("dragover", handleEditorDragOver);
  editor.view.dom.addEventListener("drop", hideBlockDropIndicator);
  dragHandleElement?.addEventListener("pointermove", handleTrackedPointerMove, {
    passive: true,
  });
  dragHandleElement?.addEventListener("pointerleave", clearTrackedPointerPosition);
  window.addEventListener("dragend", hideBlockDropIndicator, { capture: true });
  editor.commands.setMeta("hideDragHandle", true);

  return editor;
}

export class DocumentView extends HTMLElement {
  element: HTMLElement = document.createElement("div");
  private tiptapEditor?: Editor;
  private ydoc?: Y.Doc;
  private _html = "";

  set html(value: string) {
    this._html = value;
    this.renderReadHtml(value);
  }
  private startEditorQueued = false;
  private editorStartVersion = 0;
  private startingEditor = false;

  static get observedAttributes() {
    return ["editor"];
  }

  get root() {
    return this.shadowRoot;
  }

  get collaborationDocument() {
    if (!this.ydoc) {
      this.ydoc = new Y.Doc();
    }

    return this.ydoc;
  }

  set collaborationDocument(ydoc: Y.Doc) {
    if (ydoc instanceof Y.Doc) {
      this.ydoc = ydoc;
    }
  }

  setPresenceProfiles(profiles: DocumentPresenceProfile[]) {
    if (!this.tiptapEditor) return;

    this.tiptapEditor.view.dispatch(
      this.tiptapEditor.state.tr.setMeta(documentPresencePluginKey, profiles),
    );
  }

  renderReadHtml(html: string) {
    if (this.tiptapEditor) return;

    const shadow = this.ensureShadowRoot();
    this.ensureDocumentStyles(shadow);

    const content = document.createElement("div");
    content.setAttribute("part", "content");

    const inner = document.createElement("div");
    inner.innerHTML = html;
    content.appendChild(inner);

    shadow.querySelector('[part="content"]')?.replaceWith(content) ??
      shadow.appendChild(content);
  }

  private resolvedEditorContext(): EditorContext {
    const spaceId = this.getAttribute("space-id") || document.body.dataset.spaceId || "";
    const documentId = this.getAttribute("document-id") || undefined;

    return { spaceId, documentId };
  }

  private handleFileDragOver = (event: DragEvent) => {
    if (!this.tiptapEditor || !dragHasFiles(event.dataTransfer)) return;

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  private hideBlockDropIndicators() {
    document
      .querySelectorAll<HTMLElement>(".wiki-block-drop-indicator")
      .forEach((indicator) => {
        indicator.style.opacity = "0";
        indicator.style.width = "0";
      });
  }

  private handleFileDrop = (event: DragEvent) => {
    const editor = this.tiptapEditor;
    if (!editor || !dragHasFiles(event.dataTransfer)) return;

    event.preventDefault();
    this.hideBlockDropIndicators();

    const images = imageFilesFromDataTransfer(event.dataTransfer);
    if (images.length === 0) {
      return;
    }

    event.stopPropagation();
    event.stopImmediatePropagation();

    const coordinates = editor.view.posAtCoords({
      left: event.clientX,
      top: event.clientY,
    });
    const insertPos = coordinates?.pos ?? editor.state.selection.from;
    const context = this.resolvedEditorContext();
    const inserted = insertImageFilesAt(
      editor,
      editor.view,
      images,
      insertPos,
      context.spaceId ?? "",
      context.documentId,
    );

    if (!inserted) {
      alert("Image upload is not available in this editor.");
    }
  };

  private ensureDocumentStyles(shadow: ShadowRoot) {
    let style = shadow.querySelector<HTMLStyleElement>("style[data-document-styles]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.documentStyles = "";
      style.textContent = docStyles;
      shadow.prepend(style);
    }
    return style;
  }

  private ensureShadowRoot() {
    let shadow = this.root;
    if (!shadow) {
      // no template for declarative shadow DOM
      shadow = this.attachShadow({ mode: "open" });
      Object.assign(shadow, {
        createRange: document.createRange.bind(document),
      });

      // on client navigation, declarative shadow DOM does not work
      //  if its a server navigation, template is null here.
      const template = this.querySelector("template");
      if (template) {
        const clone = template.content.cloneNode(true);
        shadow.replaceChildren(clone);
      }
    }
    return shadow;
  }

  connectedCallback() {
    const shadow = this.ensureShadowRoot();
    this.ensureDocumentStyles(shadow);

    this.attachListeners();
    this.queueMaybeStartEditor();
  }

  attributeChangedCallback() {
    if (!this.hasEditorConfig()) {
      this.destroyEditor();
    } else {
      this.queueMaybeStartEditor();
    }
  }

  private queueMaybeStartEditor() {
    if (this.startEditorQueued) return;
    this.startEditorQueued = true;
    queueMicrotask(() => {
      this.startEditorQueued = false;
      this.maybeStartEditor();
    });
  }

  private maybeStartEditor() {
    const shadow = this.root;
    if (
      !this.isConnected ||
      !shadow ||
      this.tiptapEditor ||
      this.startingEditor ||
      !this.hasEditorConfig()
    ) {
      return;
    }

    this.startingEditor = true;
    const startVersion = ++this.editorStartVersion;
    const initialHtml = this.initialHtml();
    this.startingEditor = false;
    if (
      startVersion !== this.editorStartVersion ||
      !this.isConnected ||
      !this.hasEditorConfig() ||
      this.tiptapEditor
    ) {
      return;
    }

    shadow.replaceChildren();
    this.ensureDocumentStyles(shadow);
    shadow.append(this.element);

    this.element.className = "tiptap";
    this.tiptapEditor = createEditor(
      this.element,
      this.collaborationDocument,
      this.resolvedEditorContext(),
      initialHtml,
    );

    const handleUpdate = () => {
      window.dispatchEvent(new Event("editor-update"));
    };

    this.tiptapEditor.on("selectionUpdate", handleUpdate);
    this.tiptapEditor.on("update", handleUpdate);

    window.__editor = this.tiptapEditor;

    return this.tiptapEditor;
  }

  destroyEditor() {
    this.editorStartVersion++;
    this.startingEditor = false;
    if (!this.tiptapEditor) return;
    const editor = this.tiptapEditor;
    this.tiptapEditor = undefined;
    editor.destroy();
    if (window.__editor === editor) {
      window.__editor = undefined;
    }
    window.dispatchEvent(new Event("editor-destroyed"));
    this.renderReadHtml(this._html);
  }

  disconnectedCallback() {
    this.destroyEditor();
  }

  private hasEditorConfig() {
    return this.hasAttribute("editor");
  }

  private initialHtml() {
    const template = this.querySelector("template");
    if (template) {
      const content = template.content.querySelector('[part="content"]');
      const nodes = content ? content.childNodes : template.content.childNodes;
      return Array.from(nodes)
        .map((node) => {
          if (node instanceof Element) return node.outerHTML;
          return node.textContent || "";
        })
        .join("");
    }

    const shadowContent = this.root?.querySelector('[part="content"]');
    if (shadowContent) {
      return Array.from(shadowContent.childNodes)
        .map((node) => {
          if (node instanceof Element) return node.outerHTML;
          return node.textContent || "";
        })
        .join("");
    }

    return this.innerHTML;
  }

  attachListeners() {
    this.addEventListener("dragover", this.handleFileDragOver, {
      capture: true,
    });
    this.addEventListener("drop", this.handleFileDrop, {
      capture: true,
    });
    this.root?.addEventListener("dragover", this.handleFileDragOver, {
      capture: true,
    });
    this.root?.addEventListener("drop", this.handleFileDrop, {
      capture: true,
    });

    this.root?.addEventListener(
      "input",
      (_e) => {
        if (this.tiptapEditor) return; // we ignore checkbox changes in read mode only

        editing.value = true;
      },
      { capture: true },
    );

    // make link previews work
    this.root?.addEventListener(
      "pointerover",
      (e) => {
        document.dispatchEvent(
          new CustomEvent("hover", {
            detail: {
              target: e.target,
            },
          }),
        );
      },
      {
        capture: true,
      },
    );
    this.root?.addEventListener(
      "pointerout",
      (_e) => {
        document.dispatchEvent(new CustomEvent("mouseout"));
      },
      {
        capture: true,
      },
    );

    // Handle clicks on internal document links - open in overlay
    // Hold Shift to navigate normally instead
    this.root?.addEventListener(
      "click",
      ((e: MouseEvent) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;

        const target = e.target as HTMLElement;
        const anchor = target.closest("a");
        if (!anchor) return;

        const href = anchor.getAttribute("href");
        if (!href) return;

        // Check if this is an internal document link
        const documentId = this.parseDocumentId(href);
        if (!documentId) return;

        // Prevent default navigation
        e.preventDefault();
        e.stopPropagation();

        // Get spaceId from body dataset and dispatch event for overlay
        const spaceId = document.body.dataset.spaceId;
        if (!spaceId) return;

        window.dispatchEvent(
          new CustomEvent("view-document", {
            detail: { spaceId, documentId },
          }),
        );
      }) as EventListener,
      { capture: true },
    );
  }

  parseDocumentId(url: string): string | null {
    try {
      const urlObj = new URL(url, window.location.origin);
      if (urlObj.origin !== window.location.origin) return null;

      const parts = urlObj.pathname.split("/").filter(Boolean);
      // Expected: [spaceSlug, "doc", documentId]
      if (parts.length >= 3 && parts[1] === "doc") {
        return parts[2];
      }
      return null;
    } catch {
      return null;
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("document-view")) {
  customElements.define("document-view", class extends DocumentView {});
}
