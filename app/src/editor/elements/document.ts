import { authClient } from "~/src/composeables/auth-client";
import { detectAppType, stripScriptTags } from "~/src/utils/utils";
import docStyles from "../../styles/document.css?inline";
import "./textarea.ts";
import "./expression.ts";
import "./file-attachment.ts";
import { Editor } from "@tiptap/core";
import { ExtensionSuggestions } from "../extensions/ExtensionSuggestions.ts";
import * as Y from "yjs";
import { Dropcursor } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle";
import { api, type User } from "../../api/client.ts";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Collaboration from "@tiptap/extension-collaboration";
import { getUserColor } from "../../composeables/useUserProfile.ts";
import { contentExtensions } from "../extensions.ts";
import { TrailingNodePlus } from "../extensions/TrailingNodePlus.ts";
import { IndexedDBStore } from "../../utils/storage.ts";
import { createYProvider } from "../../utils/sync.ts";
import { MentionSuggestons } from "../extensions/MentionSuggestons.ts";

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

function createEditor(
  editorElement: HTMLElement,
  spaceId: string,
  documentId: string,
  user: User,
) {
  if (!documentId || !spaceId) {
    console.warn("Missing documentId or spaceId");
  }

  const ydoc = new Y.Doc();

  const roomName = `${spaceId}:${documentId || crypto.randomUUID()}`;

  const provider = createYProvider(roomName, ydoc);

  // const _persitance = new IndexeddbPersistence(roomName, ydoc);

  const editor = new Editor({
    element: editorElement,
    onContentError: ({ error, disableCollaboration }) => {
      console.error(error);
      disableCollaboration();
    },
    onCreate: async ({ editor: currentEditor }) => {
      currentEditor.commands.focus();
    },
    onUpdate: () => {
    },
    extensions: [
      ...contentExtensions(spaceId, documentId),

      TrailingNodePlus,

      DragHandle.configure({
        render: () => {
          const element = document.createElement("div");
          element.classList.add("custom-drag-handle");
          return element;
        },
      }),
      Dropcursor,
      MentionSuggestons.configure({
        spaceId: spaceId,
      }),

      ExtensionSuggestions,

      Collaboration.configure({
        document: ydoc,
      }),
      CollaborationCaret.configure({
        provider: provider,
        user: {
          name: user?.name,
          color: getUserColor(user?.email),
        },
      }),
    ]
  });

  // api.connections.get(spaceId).then(connections => {
  //   editor.storage.ticketLink.connections = connections;
  // })

  return editor;
}

class DocumentView extends HTMLElement {

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
        createRange: document.createRange.bind(document)
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
      if(!attached) {
        this.attachListeners();
      }
      attached = true;
    })

    this.attachListeners();
  }

  init(spaceId: string, documentId: string, user: User) {
    // init is called from the outside, will overwrite shadow innerHTML
    const shadow = this.root;
    if (!shadow) {
      throw new Error("No shadow root");
    }

    shadow.innerHTML = `<style>${docStyles}</style>`;
    shadow.appendChild(this.element);

    this.element.className = "tiptap";
    this.editor = createEditor(this.element, spaceId, documentId, user);

    const handleUpdate = () => {
      window.dispatchEvent(new Event("editor-update"));
    };

    this.editor.on("selectionUpdate", handleUpdate);
    this.editor.on("update", handleUpdate);

    window.__editor = this.editor;

    return this.editor;
  }

  attachListeners() {
    this.root?.addEventListener("input", (e) => {
      if (this.editor) return; // we ignore checkbox changes in read mode only

      window.dispatchEvent(new CustomEvent("edit-mode-start"));
    }, { capture: true })

    // make link previews work
    this.root?.addEventListener("pointerover", (e) => {
      document.dispatchEvent(new CustomEvent("hover", {
        detail: {
          target: e.target
        }
      }));
    }, {
      capture: true
    });
    this.root?.addEventListener("pointerout", (e) => {
      document.dispatchEvent(new CustomEvent("mouseout"));
    }, {
      capture: true
    });

    // Handle clicks on internal document links - open in overlay
    // Hold Shift to navigate normally instead
    this.root?.addEventListener("click", ((e: MouseEvent) => {
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

      window.dispatchEvent(new CustomEvent("view-document-by-slug", {
        detail: { spaceId, docSlug }
      }));
    }) as EventListener, { capture: true });
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

customElements.define("document-view", class extends DocumentView { });
customElements.define("editor-content", class extends DocumentView { });

function createFigmaEmbedUrl(figmaUrl: string): string {
  return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(figmaUrl)}`;
}

customElements.define("figma-embed", class extends HTMLElement {
  connectedCallback() {
    const figmaUrl = this.dataset.figmaUrl;
    if (!figmaUrl) return;

    const height = this.getAttribute("height") || "450px";

    const shadow = this.attachShadow({ mode: 'open' });
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
})


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
customElements.define("user-mention", class UserMentionElement extends HTMLElement {
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
});
