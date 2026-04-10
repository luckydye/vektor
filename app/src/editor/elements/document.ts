import { authClient } from "~/src/composeables/auth-client.ts";
import { detectAppType, stripScriptTags } from "~/src/utils/utils.ts";
import docStyles from "../../styles/document.css?inline";
import "./textarea.ts";
import "./expression.ts";
import "./file-attachment.ts";
import { Editor } from "@tiptap/core";
import { ExtensionSuggestions } from "../extensions/ExtensionSuggestions.ts";
import * as Y from "yjs";
import { Dropcursor } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle";
import type { User } from "../../api/client.ts";
import Collaboration from "@tiptap/extension-collaboration";
import { contentExtensions } from "../extensions.ts";
import { TrailingNodePlus } from "../extensions/TrailingNodePlus.ts";
import { InlineSuggestions } from "../extensions/InlineSuggestions.ts";
import type { IndexedDBStore } from "../../utils/storage.ts";
import { joinPresenceRoom, joinYjsRoom } from "../../utils/sync.ts";
import { MentionSuggestons } from "../extensions/MentionSuggestons.ts";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";
import type { PresenceEnvelope, PresenceUser } from "../../utils/realtime.ts";

declare global {
  interface Window {
    __editor?: Editor;
  }
}

type EditorStoreEntry = {
  documentId: string;
  content: string;
  createdAt: number;
};

type EditorPresenceState = {
  kind: "editor";
  focused: boolean;
  selection: {
    anchor: Record<string, unknown>;
    head: Record<string, unknown>;
  } | null;
};

const editorPresencePluginKey = new PluginKey("wiki-editor-presence");

function getYSyncState(state: Editor["state"]) {
  const plugin = state.plugins.find((candidate) => candidate.key === "y-sync$");
  return plugin?.getState(state) as
    | {
        binding?: { mapping?: Map<unknown, { nodeSize: number }> };
      }
    | undefined;
}

function getPresenceColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }

  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

function serializeRelativePosition(position: unknown) {
  return JSON.parse(JSON.stringify(position)) as Record<string, unknown>;
}

function toPresenceUser(user: User): PresenceUser {
  return {
    id: user.id,
    name: user.name,
    image: user.image,
    color: getPresenceColor(user.id),
  };
}

function createPresencePlugin(
  ydoc: Y.Doc,
  localClientId: string,
  getPresences: () => Map<string, PresenceEnvelope<EditorPresenceState>>,
) {
  const docType = ydoc.getXmlFragment("default");

  return new Plugin({
    key: editorPresencePluginKey,
    state: {
      init: () => 0,
      apply(tr, value) {
        return tr.getMeta(editorPresencePluginKey) === "refresh" ? value + 1 : value;
      },
    },
    props: {
      decorations(state) {
        const syncState = getYSyncState(state);
        const mapping = syncState?.binding?.mapping;
        if (!mapping) {
          return DecorationSet.empty;
        }

        const decorations: Decoration[] = [];
        for (const presence of getPresences().values()) {
          if (presence.clientId === localClientId) {
            continue;
          }

          const remoteState = presence.state;
          if (remoteState?.kind !== "editor" || !remoteState.selection) {
            continue;
          }

          const anchor = relativePositionToAbsolutePosition(
            ydoc,
            docType,
            Y.createRelativePositionFromJSON(remoteState.selection.anchor),
            mapping as any,
          );
          const head = relativePositionToAbsolutePosition(
            ydoc,
            docType,
            Y.createRelativePositionFromJSON(remoteState.selection.head),
            mapping as any,
          );

          if (anchor === null || head === null) {
            continue;
          }

          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          const color = presence.user.color ?? getPresenceColor(presence.user.id);

          if (from !== to) {
            decorations.push(
              Decoration.inline(from, to, {
                class: "ProseMirror-yjs-selection",
                style: `background-color: color-mix(in srgb, ${color} 24%, transparent);`,
              }),
            );
          }

          decorations.push(
            Decoration.widget(head, () => {
              const caret = document.createElement("span");
              caret.className = "collaboration-carets__caret";
              Object.assign(caret.style, {
                borderLeft: `2px solid ${color}`,
                marginLeft: "-1px",
                marginRight: "-1px",
                pointerEvents: "none",
                position: "relative",
                display: "inline-block",
                height: "1.1em",
                verticalAlign: "text-top",
              });
              if (!remoteState.focused) {
                caret.style.opacity = "0.65";
              }

              const label = document.createElement("span");
              label.className = "collaboration-carets__label";
              Object.assign(label.style, {
                position: "absolute",
                left: "-1px",
                top: "-1.45em",
                backgroundColor: color,
                color: "#111",
                fontSize: "12px",
                fontWeight: "600",
                lineHeight: "1",
                whiteSpace: "nowrap",
                borderRadius: "3px 3px 3px 0",
                padding: "0.15rem 0.35rem",
                boxShadow: "0 1px 2px rgb(0 0 0 / 0.18)",
              });
              label.textContent = presence.user.name;
              if (!remoteState.focused) {
                label.style.opacity = "0.75";
              }

              caret.appendChild(label);
              return caret;
            }, {
              key: `${presence.clientId}:${presence.updatedAt}`,
              side: -1,
            }),
          );
        }

        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

function createEditor(
  editorElement: HTMLElement,
  spaceId: string,
  documentId: string | undefined,
  user: User,
  html?: string,
) {
  const ydoc = new Y.Doc();
  const presenceClientId = crypto.randomUUID();
  const presenceUser = toPresenceUser(user);
  const remotePresences = new Map<string, PresenceEnvelope<EditorPresenceState>>();
  const leaveYjsRoom = documentId ? joinYjsRoom(spaceId, documentId, ydoc) : () => {};

  // const _persitance = new IndexeddbPersistence(roomName, ydoc);
  let lastPointerX = 0;
  let lastPointerY = 0;
  let hasPointerPosition = false;
  let blockDropIndicator: HTMLDivElement | null = null;
  let dragHandleElement: HTMLElement | null = null;

  let editor: Editor;
  const presencePlugin = createPresencePlugin(ydoc, presenceClientId, () => remotePresences);
  let leavePresenceRoom = () => {};
  let presenceHandle: { update: (state: EditorPresenceState) => void; leave: () => void } | null = null;

  const refreshPresenceDecorations = () => {
    if (!editor?.view) return;
    editor.view.dispatch(editor.state.tr.setMeta(editorPresencePluginKey, "refresh"));
  };

  const buildPresenceState = (): EditorPresenceState => {
    const selection = editor?.state.selection;
    const syncState = editor ? getYSyncState(editor.state) : undefined;
    const mapping = syncState?.binding?.mapping;

    if (!editor || !selection || !mapping) {
      return {
        kind: "editor",
        focused: editor?.isFocused ?? false,
        selection: null,
      };
    }

    return {
      kind: "editor",
      focused: editor.isFocused,
      selection: {
        anchor: serializeRelativePosition(absolutePositionToRelativePosition(
          selection.anchor,
          ydoc.getXmlFragment("default"),
          mapping as any,
        )),
        head: serializeRelativePosition(absolutePositionToRelativePosition(
          selection.head,
          ydoc.getXmlFragment("default"),
          mapping as any,
        )),
      },
    };
  };

  const trackPointerPosition = (clientX: number, clientY: number) => {
    lastPointerX = clientX;
    lastPointerY = clientY;
    hasPointerPosition = true;
  };

  const handleTrackedPointerMove = (event: MouseEvent | PointerEvent) => {
    trackPointerPosition(event.clientX, event.clientY);
  };

  const isPointInsideRect = (
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ) => {
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
      borderRadius: "999px",
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

      let current: HTMLElement | null = element;
      while (
        current &&
        current.parentElement &&
        current.parentElement !== editor.view.dom
      ) {
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
    content: html,
    onContentError: ({ error, disableCollaboration }) => {
      console.error(error);
      disableCollaboration();
    },
    onCreate: async ({ editor: currentEditor }) => {
      currentEditor.registerPlugin(presencePlugin);
      currentEditor.commands.focus();
      if (!documentId) {
        return;
      }
      const presence = joinPresenceRoom<EditorPresenceState>(
        spaceId,
        documentId,
        presenceClientId,
        presenceUser,
        (event) => {
          if (event.type === "presence-snapshot") {
            remotePresences.clear();
            for (const presence of event.presences) {
              if (presence.clientId === presenceClientId) continue;
              remotePresences.set(presence.clientId, presence);
            }
          } else if (event.type === "presence-update") {
            if (event.presence.clientId === presenceClientId) {
              return;
            }
            remotePresences.set(event.presence.clientId, event.presence);
          } else {
            remotePresences.delete(event.clientId);
          }
          refreshPresenceDecorations();
        },
        buildPresenceState(),
      );
      presenceHandle = presence;
      leavePresenceRoom = presence.leave;
      presence.update(buildPresenceState());
    },
    onUpdate: () => {},
    onDestroy: () => {
      cleanupDragHandleSync();
      cleanupBlockDropIndicator();
      leavePresenceRoom();
      leaveYjsRoom();
    },
    extensions: [
      ...contentExtensions(spaceId, documentId),

      TrailingNodePlus,

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
        spaceId: spaceId,
      }),

      ExtensionSuggestions,
      InlineSuggestions,

      Collaboration.configure({
        document: ydoc,
      }),
    ],
  });

  editor.on("selectionUpdate", () => {
    presenceHandle?.update(buildPresenceState());
  });
  editor.on("focus", () => {
    presenceHandle?.update(buildPresenceState());
  });
  editor.on("blur", () => {
    presenceHandle?.update(buildPresenceState());
  });

  editor.view.dom.addEventListener("mousemove", handleEditorMouseMove);
  editor.view.dom.addEventListener("mousemove", handleTrackedPointerMove, { passive: true });
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
  editor?: Editor;
  store?: IndexedDBStore<EditorStoreEntry>;

  get root() {
    return this.shadowRoot;
  }

  connectedCallback() {
    if (!this.root) {
      // no template for declarative shadow DOM
      const shadow = this.attachShadow({ mode: "open" });
      Object.assign(shadow, {
        createRange: document.createRange.bind(document),
      });

      // on client navigation, declarative shadow DOM does not work
      //  if its a server navigation, template is null here.
      const template = this.querySelector("template");
      if (template) {
        const clone = template.content.cloneNode(true);
        shadow.innerHTML = `
          <style>${docStyles}</style>
        `;
        shadow.append(clone);
      }
    }

    this.addEventListener("keydown", (e) => {
      const action = Actions.getActionForShortcut(e);
      if (action) return;

      e.stopPropagation();
    });

    let attached = false;
    this.addEventListener("pointerover", () => {
      if (!attached) {
        this.attachListeners();
      }
      attached = true;
    });

    this.attachListeners();
  }

  init(spaceId: string, documentId: string | undefined, user: User, html?: string) {
    // init is called from the outside, will overwrite shadow innerHTML
    const shadow = this.root;
    if (!shadow) {
      throw new Error("No shadow root");
    }

    shadow.innerHTML = `<style>${docStyles}</style>`;
    shadow.append(this.element);

    this.element.className = "tiptap";
    this.editor = createEditor(this.element, spaceId, documentId, user, html);

    const handleUpdate = () => {
      window.dispatchEvent(new Event("editor-update"));
    };

    this.editor.on("selectionUpdate", handleUpdate);
    this.editor.on("update", handleUpdate);

    window.__editor = this.editor;

    return this.editor;
  }

  attachListeners() {
    this.root?.addEventListener(
      "input",
      (e) => {
        if (this.editor) return; // we ignore checkbox changes in read mode only

        window.dispatchEvent(new CustomEvent("edit-mode-start"));
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
      (e) => {
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
        const docSlug = this.parseDocumentSlug(href);
        if (!docSlug) return;

        // Prevent default navigation
        e.preventDefault();
        e.stopPropagation();

        // Get spaceId from body dataset and dispatch event for overlay
        const spaceId = document.body.dataset.spaceId;
        if (!spaceId) return;

        window.dispatchEvent(
          new CustomEvent("view-document-by-slug", {
            detail: { spaceId, docSlug },
          }),
        );
      }) as EventListener,
      { capture: true },
    );
  }

  // Extract document slug from URL like /space-slug/doc/document-slug
  parseDocumentSlug(url: string): string | null {
    try {
      const urlObj = new URL(url, window.location.origin);
      if (urlObj.origin !== window.location.origin) return null;

      const parts = urlObj.pathname.split("/").filter(Boolean);
      // Expected: [spaceSlug, "doc", ...docSlugParts]
      if (parts.length >= 3 && parts[1] === "doc") {
        return parts.slice(2).join("/");
      }
      return null;
    } catch {
      return null;
    }
  }
}

customElements.define("document-view", class extends DocumentView {});

function createFigmaEmbedUrl(figmaUrl: string): string {
  return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(figmaUrl)}`;
}

customElements.define(
  "figma-embed",
  class extends HTMLElement {
    connectedCallback() {
      const figmaUrl = this.dataset.figmaUrl;
      if (!figmaUrl) return;

      const height = this.getAttribute("height") || "450px";

      const shadow = this.attachShadow({ mode: "open" });
      shadow.innerHTML = `
      <style>
        :host {
          display: block;
          border: 1px solid #e5e7eb;
          border-radius: var(--radius-xl);
          overflow: hidden;
        }
      </style>
    `;

      const iframe = document.createElement("iframe");
      iframe.src = createFigmaEmbedUrl(figmaUrl);
      iframe.style.cssText = "width: 100%; height: 100%; display: block; border: none;";
      if (height) {
        iframe.style.height = `${height}px`;
      }
      iframe.setAttribute("allowfullscreen", "true");

      shadow.appendChild(iframe);
    }
  },
);

customElements.define(
  "html-block",
  class extends HTMLElement {
    shadow: ShadowRoot | null = null;
    editmode: boolean = false;

    connectedCallback() {
      this.shadow = this.attachShadow({ mode: "open" });
      this.updateContent();
    }

    attributeChangedCallback(name: string, oldValue: string, newValue: string) {
      if (name === "data-html" && oldValue !== newValue) {
        this.updateContent();
      }
      if (name === "contenteditable") {
        this.editmode = this.hasAttribute("contenteditable");
        this.updateContent();
      }
    }

    static get observedAttributes() {
      return ["data-html", "contenteditable"];
    }

    private updateContent() {
      if (!this.shadow) return;

      const htmlString = this.getAttribute("data-html");

      const container = document.createElement("div");
      container.innerHTML = stripScriptTags(htmlString || "");
      container.contentEditable = this.closest(".tiptap") ? "true" : "false";
      container.addEventListener("input", () => {
        const html = container.innerHTML;
        this.dispatchEvent(new CustomEvent("change", { detail: html }));
      });

      this.shadow.appendChild(container);
    }
  },
);

function getTicketUrlTemplate(
  appType: "jira" | "youtrack" | "linear" | "github" | "gitlab",
  baseUrl: string,
): string {
  if (!baseUrl) {
    return "";
  }

  const cleanUrl = baseUrl.replace(/\/$/, "");

  switch (appType) {
    case "jira":
      return `${cleanUrl}/browse/{ticketId}`;
    case "youtrack":
      return `${cleanUrl}/issue/{ticketId}`;
    case "linear":
      return `${cleanUrl}/issue/{ticketId}`;
    case "github":
      return `${cleanUrl}/issues/{ticketId}`;
    case "gitlab":
      return `${cleanUrl}/-/issues/{ticketId}`;
    default:
      return `${cleanUrl}/{ticketId}`;
  }
}

customElements.define(
  "ticket-link",
  class extends HTMLElement {
    constructor() {
      super();

      this.addEventListener("click", this.click);
      this.addEventListener("auxclick", this.click);
    }

    click() {
      const connectionLabel = this.getAttribute("data-connection-label");
      if (!connectionLabel) {
        throw new Error("No connection label");
      }

      const appType = detectAppType(connectionLabel);
      if (!appType) {
        throw new Error("Missing valid appType");
      }

      const ticketId = this.getAttribute("data-ticket-id");
      if (!ticketId) {
        throw new Error("Missing ticketId");
      }

      const connectionUrl = this.getAttribute("data-connection-url");
      if (!connectionUrl) {
        throw new Error("Missing connectionUrl");
      }

      const baseUrl = new URL(connectionUrl).origin;
      const urlTemplate = getTicketUrlTemplate(appType, baseUrl);
      const ticketUrl = urlTemplate.replace("{ticketId}", ticketId);
      window.open(ticketUrl, "_blank");
    }
  },
);

// Custom element for user mentions in the editor
// Renders @mentions with click handling and tooltip support
//
// Usage in HTML:
//   <user-mention email="user@example.com">@John Doe</user-mention>
//
// Event handling:
//   editor.view.dom.addEventListener('mention-click', (e) => {
//     console.log('Mentioned user:', e.detail.email);
//     // Navigate to user profile, show tooltip, etc.
//   });
customElements.define(
  "user-mention",
  class UserMentionElement extends HTMLElement {
    connectedCallback() {
      this.setAttribute("role", "button");
      this.setAttribute("tabindex", "0");

      this.addEventListener("click", this.handleClick);
      this.addEventListener("keydown", this.handleKeyDown);

      // Check if this mention is for the current user
      this.checkSelfMention();
    }

    async checkSelfMention() {
      const mentionEmail = this.getAttribute("email");
      if (!mentionEmail) return;

      try {
        const { data: session } = await authClient.getSession();
        if (session?.user?.email === mentionEmail) {
          this.setAttribute("data-self-mention", "true");
        }
      } catch {
        // Silently fail if we can't check
      }
    }

    disconnectedCallback() {
      this.removeEventListener("click", this.handleClick);
      this.removeEventListener("keydown", this.handleKeyDown);
    }

    handleClick = (event: Event) => {
      event.preventDefault();
      const email = this.getAttribute("email");

      if (email) {
        this.dispatchEvent(
          new CustomEvent("mention-click", {
            detail: { email },
            bubbles: true,
            composed: true,
          }),
        );
      }
    };

    handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.handleClick(event);
      }
    };

    get email(): string | null {
      return this.getAttribute("email");
    }

    set email(value: string | null) {
      if (value) {
        this.setAttribute("email", value);
      } else {
        this.removeAttribute("email");
      }
    }
  },
);
