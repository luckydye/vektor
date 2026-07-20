import { editing } from "#composeables/useEditor.ts";
import docStyles from "./css/document.css?inline";
import "./elements/textarea.ts";
import "./elements/expression.ts";
import "./elements/file-attachment.ts";
import "./elements/document-attachment.ts";
import type { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import type { EditorState } from "@tiptap/pm/state";
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import * as Y from "yjs";
import {
  colorForPresenceProfile,
  type DocumentPresenceProfile,
  findYSyncState,
} from "./collaboration.ts";
import { DragHandle } from "./extensions/DragHandle.ts";
import { Dropcursor } from "./extensions/Dropcursor.ts";
import { ExtensionSuggestions } from "./extensions/ExtensionSuggestions.ts";
import {
  imageFilesFromDataTransfer,
  insertImageFilesAt,
} from "./extensions/ImageUpload.ts";
import { InlineSuggestions } from "./extensions/InlineSuggestions.ts";
import { MentionSuggestions } from "./extensions/MentionSuggestions.ts";
import { TrailingNodePlus } from "./extensions/TrailingNodePlus.ts";
import {
  createBaseEditor,
  documentExtensions,
  type EditorContext,
} from "./extensions.ts";

type ProsemirrorMapping = Parameters<typeof relativePositionToAbsolutePosition>[3];

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
      mapping as ProsemirrorMapping,
    );
  } catch {
    return null;
  }
}

function absolutePresencePosition(state: EditorState, position: unknown) {
  if (typeof position !== "number" || !Number.isFinite(position)) return null;
  const maxPos = Math.max(state.doc.content.size - 1, 0);
  return Math.max(0, Math.min(position, maxPos));
}

function resolvePresencePosition(
  state: EditorState,
  ydoc: Y.Doc,
  relativePosition: unknown,
  absolutePosition: unknown,
) {
  if (relativePosition) {
    return relativePresencePositionToAbsolute(state, ydoc, relativePosition);
  }

  return absolutePresencePosition(state, absolutePosition);
}

function createEditor(
  editorElement: HTMLElement,
  ydoc: Y.Doc,
  context: EditorContext = {},
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

    // Keep the handle alive while the pointer is in the left gutter zone (where
    // the handle lives) so it can be reached without the drag handle vanishing.
    const dom = editor?.view?.dom;
    if (event && dom) {
      const rect = dom.getBoundingClientRect();
      const inGutter =
        event.clientY >= rect.top - 8 &&
        event.clientY <= rect.bottom + 8 &&
        event.clientX >= rect.left - 64 &&
        event.clientX <= rect.right + 8;
      if (inGutter) return;
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

      // Inside a list, the drop indicator should snap between list items (that
      // is where a dragged item actually lands), not before/after the whole list.
      const listItem = element.closest<HTMLElement>("li");
      if (listItem && editor.view.dom.contains(listItem)) {
        return listItem;
      }

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

  editor = createBaseEditor({
    element: editorElement,
    enableCoreExtensions: true,
    onContentError: ({ error, disableCollaboration }) => {
      console.error(error);
      disableCollaboration();
    },
    onCreate: async ({ editor: currentEditor }) => {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
    },
    onUpdate: () => {},
    onDestroy: () => {
      cleanupDragHandleSync();
      cleanupBlockDropIndicator();
    },
    extensions: [
      ...documentExtensions(
        context,
        MentionSuggestions.configure({
          spaceId: context.spaceId ?? "",
          documentId: context.documentId,
        }),
      ),

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
        onNodeChange: (options) => {
          const { node } = options;
          if (!node) return;
          const pos =
            "pos" in options && typeof options.pos === "number" ? options.pos : -1;
          if (pos < 0) return;
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
      ExtensionSuggestions,
      InlineSuggestions,

      Collaboration.configure({
        document: ydoc,
      }),
    ],
  });

  editor.view.dom.addEventListener("mousemove", handleEditorMouseMove);
  editor.view.dom.addEventListener("mousemove", handleTrackedPointerMove, {
    passive: true,
  });
  editor.view.dom.addEventListener("mouseleave", clearTrackedPointerPosition);
  editor.view.dom.addEventListener("dragover", handleEditorDragOver);
  editor.view.dom.addEventListener("drop", hideBlockDropIndicator);
  const renderedDragHandleElement = dragHandleElement as HTMLElement | null;
  renderedDragHandleElement?.addEventListener("pointermove", handleTrackedPointerMove, {
    passive: true,
  });
  renderedDragHandleElement?.addEventListener(
    "pointerleave",
    clearTrackedPointerPosition,
  );
  window.addEventListener("dragend", hideBlockDropIndicator, { capture: true });
  editor.commands.setMeta("hideDragHandle", true);

  return editor;
}

export class DocumentView extends HTMLElement {
  element: HTMLElement = document.createElement("div");
  private tiptapEditor?: Editor;
  private ydoc?: Y.Doc;
  private _html = "";
  private presenceProfiles: DocumentPresenceProfile[] = [];
  private presenceOverlay?: HTMLDivElement;
  private presenceRenderFrame: number | null = null;
  private presenceLayoutListenersAttached = false;

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

  get editorInstance() {
    return this.tiptapEditor;
  }

  get collaborationDocument(): Y.Doc | undefined {
    return this.ydoc;
  }

  set collaborationDocument(ydoc: Y.Doc | undefined) {
    if (ydoc instanceof Y.Doc) {
      if (this.ydoc === ydoc) {
        this.queueMaybeStartEditor();
        return;
      }
      const hadEditor = !!this.tiptapEditor;
      if (hadEditor) {
        this.destroyEditor();
      }
      this.ydoc = ydoc;
      this.queueMaybeStartEditor();
    }
  }

  setEditorEnabled(enabled: boolean, ydoc?: Y.Doc) {
    if (ydoc instanceof Y.Doc) {
      this.collaborationDocument = ydoc;
    }

    if (enabled) {
      if (!this.hasEditorConfig()) {
        this.setAttribute("editor", "");
      }
      this.queueMaybeStartEditor();
      return;
    }

    if (this.hasEditorConfig()) {
      this.removeAttribute("editor");
    } else {
      this.destroyEditor();
    }
  }

  setPresenceProfiles(profiles: DocumentPresenceProfile[]) {
    this.presenceProfiles = profiles;
    this.schedulePresenceOverlayRender();
  }

  renderReadHtml(html: string) {
    this._html = html;
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

  private handleFileDragOverEvent = (event: Event) => {
    if (event instanceof DragEvent) {
      this.handleFileDragOver(event);
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

  private handleFileDropEvent = (event: Event) => {
    if (event instanceof DragEvent) {
      this.handleFileDrop(event);
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

  private ensureShadowRootCompatibility(shadow: ShadowRoot) {
    if (
      typeof (shadow as ShadowRoot & { createRange?: unknown }).createRange !== "function"
    ) {
      Object.defineProperty(shadow, "createRange", {
        configurable: true,
        value: document.createRange.bind(document),
      });
    }
  }

  private ensureShadowRoot() {
    let shadow = this.root;
    if (!shadow) {
      // no template for declarative shadow DOM
      shadow = this.attachShadow({ mode: "open" });

      // on client navigation, declarative shadow DOM does not work
      //  if its a server navigation, template is null here.
      const template = this.querySelector("template");
      if (template) {
        const clone = template.content.cloneNode(true);
        shadow.replaceChildren(clone);
      }
    }
    this.ensureShadowRootCompatibility(shadow);
    return shadow;
  }

  private ensurePresenceOverlay(shadow: ShadowRoot) {
    if (this.presenceOverlay?.isConnected) return this.presenceOverlay;

    const overlay = document.createElement("div");
    overlay.className = "document-presence-overlay";
    shadow.append(overlay);
    this.presenceOverlay = overlay;
    return overlay;
  }

  private clearPresenceOverlay() {
    if (this.presenceRenderFrame !== null) {
      cancelAnimationFrame(this.presenceRenderFrame);
      this.presenceRenderFrame = null;
    }
    this.presenceOverlay?.replaceChildren();
  }

  private schedulePresenceOverlayRender = () => {
    if (this.presenceRenderFrame !== null) return;
    this.presenceRenderFrame = requestAnimationFrame(() => {
      this.presenceRenderFrame = null;
      this.renderPresenceOverlay();
    });
  };

  private createPresenceCaret(
    profile: DocumentPresenceProfile,
    color: string,
    rect: { left: number; top: number; bottom: number },
  ) {
    const caret = document.createElement("div");
    caret.className = "document-presence-caret";
    caret.style.left = `${rect.left}px`;
    caret.style.top = `${rect.top}px`;
    caret.style.height = `${Math.max(rect.bottom - rect.top, 12)}px`;
    caret.style.borderColor = color;

    const label = document.createElement("div");
    label.className = "document-presence-label";
    label.style.backgroundColor = color;
    label.textContent = profile.user.name || "User";
    caret.append(label);

    return caret;
  }

  private createPresenceSelectionRect(
    color: string,
    rect: { left: number; top: number; width: number; height: number },
  ) {
    const selection = document.createElement("div");
    selection.className = "document-presence-selection";
    selection.style.left = `${rect.left}px`;
    selection.style.top = `${rect.top}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    selection.style.backgroundColor = `${color}70`;
    return selection;
  }

  private presenceSelectionRects(from: number, to: number) {
    const view = this.tiptapEditor?.view;
    if (!view) return [];

    try {
      const start = view.domAtPos(from);
      const end = view.domAtPos(to);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
    } catch {
      return [];
    }
  }

  private renderPresenceOverlay() {
    const editor = this.tiptapEditor;
    const ydoc = this.collaborationDocument;
    const shadow = this.root;
    if (!editor || !ydoc || !shadow) {
      this.clearPresenceOverlay();
      return;
    }

    const overlay = this.ensurePresenceOverlay(shadow);
    overlay.replaceChildren();

    // Viewport rects from the editor view are mapped into the overlay's own
    // coordinate space. Dividing by the effective scale keeps positions
    // correct when an ancestor is CSS-transformed (e.g. the zoomed canvas
    // world around an embedded document editor).
    const overlayRect = overlay.getBoundingClientRect();
    const overlayScale =
      overlay.offsetWidth > 0 ? overlayRect.width / overlay.offsetWidth : 1;
    const toOverlayRect = (rect: {
      left: number;
      top: number;
      bottom: number;
      width?: number;
    }) => ({
      left: (rect.left - overlayRect.left) / overlayScale,
      top: (rect.top - overlayRect.top) / overlayScale,
      bottom: (rect.bottom - overlayRect.top) / overlayScale,
      width: (rect.width ?? 0) / overlayScale,
      height: (rect.bottom - rect.top) / overlayScale,
    });

    for (const profile of this.presenceProfiles) {
      if (
        profile.state?.kind !== "editor" ||
        profile.state.focused !== true ||
        !profile.state.selection
      ) {
        continue;
      }

      const selection = profile.state.selection;
      const anchor = resolvePresencePosition(
        editor.state,
        ydoc,
        selection.anchor,
        selection.absoluteAnchor,
      );
      const head = resolvePresencePosition(
        editor.state,
        ydoc,
        selection.head,
        selection.absoluteHead,
      );
      if (anchor === null || head === null) continue;

      const maxPos = Math.max(editor.state.doc.content.size - 1, 0);
      const from = Math.max(0, Math.min(anchor, head, maxPos));
      const to = Math.max(0, Math.min(Math.max(anchor, head), maxPos));
      const color = colorForPresenceProfile(profile);

      const selectionRects = from === to ? [] : this.presenceSelectionRects(from, to);
      for (const rect of selectionRects) {
        overlay.append(this.createPresenceSelectionRect(color, toOverlayRect(rect)));
      }

      const caretRect =
        selectionRects[0] ??
        editor.view.coordsAtPos(Math.max(0, Math.min(from === to ? head : from, maxPos)));
      overlay.append(this.createPresenceCaret(profile, color, toOverlayRect(caretRect)));
    }
  }

  private attachPresenceLayoutListeners() {
    if (this.presenceLayoutListenersAttached) return;
    this.presenceLayoutListenersAttached = true;
    window.addEventListener("scroll", this.schedulePresenceOverlayRender, true);
    window.addEventListener("resize", this.schedulePresenceOverlayRender);
  }

  private detachPresenceLayoutListeners() {
    if (!this.presenceLayoutListenersAttached) return;
    this.presenceLayoutListenersAttached = false;
    window.removeEventListener("scroll", this.schedulePresenceOverlayRender, true);
    window.removeEventListener("resize", this.schedulePresenceOverlayRender);
  }

  connectedCallback() {
    this.upgradeProperty("collaborationDocument");
    const shadow = this.ensureShadowRoot();
    this.ensureDocumentStyles(shadow);

    this.attachPresenceLayoutListeners();
    this.attachListeners();
    this.queueMaybeStartEditor();
  }

  private upgradeProperty(name: "collaborationDocument") {
    if (!Object.hasOwn(this, name)) return;
    const value = this[name];
    delete this[name];
    this[name] = value;
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

  private preserveScrollPositionDuringLayoutChange() {
    const scrollPositions: Array<{
      element: HTMLElement;
      left: number;
      top: number;
    }> = [];
    for (
      let element: HTMLElement | null = this;
      element;
      element = element.parentElement
    ) {
      if (element.scrollLeft || element.scrollTop) {
        scrollPositions.push({
          element,
          left: element.scrollLeft,
          top: element.scrollTop,
        });
      }
    }

    const previousMinHeight = this.style.minHeight;
    this.style.minHeight = `${this.getBoundingClientRect().height}px`;

    return () => {
      const restoreScrollPosition = () => {
        for (const { element, left, top } of scrollPositions) {
          element.scrollTo({ left, top, behavior: "instant" });
        }
      };

      restoreScrollPosition();
      requestAnimationFrame(() => {
        restoreScrollPosition();
        this.style.minHeight = previousMinHeight;
        requestAnimationFrame(restoreScrollPosition);
      });
    };
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
    this.startingEditor = false;
    if (
      startVersion !== this.editorStartVersion ||
      !this.isConnected ||
      !this.hasEditorConfig() ||
      this.tiptapEditor
    ) {
      return;
    }

    const collaborationDocument = this.collaborationDocument;
    if (!collaborationDocument) return;

    const finishLayoutChange = this.preserveScrollPositionDuringLayoutChange();

    shadow.replaceChildren();
    this.ensureDocumentStyles(shadow);
    shadow.append(this.element);

    this.element.className = "tiptap";
    this.tiptapEditor = createEditor(
      this.element,
      collaborationDocument,
      this.resolvedEditorContext(),
    );

    const handleUpdate = () => {
      window.dispatchEvent(new Event("editor-update"));
      this.schedulePresenceOverlayRender();
    };

    this.tiptapEditor.on("selectionUpdate", handleUpdate);
    this.tiptapEditor.on("update", handleUpdate);
    this.setPresenceProfiles(this.presenceProfiles);
    finishLayoutChange();

    this.dispatchEvent(
      new CustomEvent("editor-ready", {
        detail: { editor: this.tiptapEditor },
      }),
    );

    return this.tiptapEditor;
  }

  destroyEditor() {
    this.editorStartVersion++;
    this.startingEditor = false;
    if (!this.tiptapEditor) return;
    const finishLayoutChange = this.preserveScrollPositionDuringLayoutChange();
    const editor = this.tiptapEditor;
    this.tiptapEditor = undefined;
    this.clearPresenceOverlay();
    editor.destroy();
    this.dispatchEvent(
      new CustomEvent("editor-destroyed", {
        detail: { editor },
      }),
    );
    window.dispatchEvent(new Event("editor-destroyed"));
    this.renderReadHtml(this._html);
    finishLayoutChange();
  }

  disconnectedCallback() {
    this.detachPresenceLayoutListeners();
    this.clearPresenceOverlay();
    this.destroyEditor();
  }

  private hasEditorConfig() {
    return this.hasAttribute("editor");
  }

  attachListeners() {
    this.addEventListener("dragover", this.handleFileDragOverEvent, {
      capture: true,
    });
    this.addEventListener("drop", this.handleFileDropEvent, {
      capture: true,
    });
    this.root?.addEventListener("dragover", this.handleFileDragOverEvent, {
      capture: true,
    });
    this.root?.addEventListener("drop", this.handleFileDropEvent, {
      capture: true,
    });

    this.root?.addEventListener(
      "input",
      (event) => {
        if (this.tiptapEditor) return;

        const checkbox = event.target;
        if (checkbox instanceof HTMLInputElement && checkbox.type === "checkbox") {
          const checkboxes = this.root?.querySelectorAll<HTMLInputElement>(
            'ul[data-type="taskList"] input[type="checkbox"]',
          );
          const index = checkboxes ? Array.from(checkboxes).indexOf(checkbox) : -1;
          if (index >= 0) {
            this.dispatchEvent(
              new CustomEvent("task-toggle-request", {
                bubbles: true,
                composed: true,
                detail: { index },
              }),
            );
          }
        }

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
