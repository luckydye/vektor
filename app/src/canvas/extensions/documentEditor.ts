// Inline collaborative editor for a document embedded on the canvas. Mounted
// only for the embed the user activated, it joins the embedded document's own
// Yjs room and joins its presence room lazily — on the first editor focus — so
// idle embeds never hold an editor or appear as present.
//
// The collaboration session arrives as a property from the app shell, so
// nothing here imports a framework. Light DOM so the global .canvas-doc-editor
// styles apply and the --canvas-* variables inherit, as with every other canvas
// element.
import type { Editor } from "@tiptap/core";
import { html, render } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";
import type * as Y from "yjs";
import { documentIcon } from "#assets/icons.ts";
import type { CanvasDocumentCollaboration } from "#canvas/document/collaboration.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import {
  currentEditorPresenceState,
  type DocumentPresenceProfile,
} from "#editor/collaboration.ts";
import { HostElement } from "./CanvasElementBase.ts";

type DocumentViewElement = HTMLElement & {
  editorInstance?: Editor;
  setEditorEnabled?: (enabled: boolean, ydoc?: Y.Doc) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
  setLocalAppearance?: (appearance: PublicUserAppearance | undefined) => void;
};

export class CanvasDocumentEditorElement extends HostElement {
  /**
   * Single-word property names, set by the host as `session.props`. Assigning
   * any of them schedules a render; the element starts once it has both a
   * collaboration session and has been connected.
   */
  spaceId = "";
  documentId = "";
  /**
   * Not `title`: that is an `HTMLElement` accessor, and writing it would set the
   * attribute and give the whole editor a native browser tooltip.
   */
  documentTitle = "";
  headerImage = "";
  /**
   * When the edit session was started by clicking a checkbox on the read-only
   * card, this is that checkbox's ordinal so the toggle is replayed in the
   * editor (the read-only preview cannot persist it).
   */
  toggleTaskIndex: number | null = null;

  #collaboration: CanvasDocumentCollaboration | null = null;

  /**
   * Also the start signal.
   *
   * The host assigns properties from a lit `ref` callback, which runs after the
   * element is already connected — so `connectedCallback` alone is always too
   * early. Whichever of the two happens last starts the editor.
   */
  set collaboration(value: CanvasDocumentCollaboration | null) {
    this.#collaboration = value;
    // On a microtask so the rest of the property batch lands first, whatever
    // order the host assigns it in.
    queueMicrotask(() => this.start());
  }
  get collaboration(): CanvasDocumentCollaboration | null {
    return this.#collaboration;
  }

  private view: DocumentViewElement | null = null;
  private editor: Editor | undefined;
  private status: "connecting" | "ready" | "error" = "connecting";
  private errorMessage = "";
  private started = false;
  private disposed = false;
  private renderQueued = false;
  private pendingTaskToggle: number | null = null;
  private leaveEditorSubscriptions: (() => void) | null = null;
  private unsubscribeCollaboration: (() => void) | null = null;

  connectedCallback(): void {
    this.start();
  }

  /** See `CanvasElementBase`: a reorder disconnects and reconnects the node. */
  disconnectedCallback(): void {}

  private start(): void {
    if (this.started || !this.#collaboration || !this.isConnected) return;
    this.started = true;
    this.pendingTaskToggle = this.toggleTaskIndex ?? null;

    this.unsubscribeCollaboration = this.#collaboration.subscribe(() => {
      this.pushCollaborationState();
    });

    this.renderNow();
    void this.join();
  }

  private async join(): Promise<void> {
    try {
      // document-view is loaded lazily so the canvas chunk stays lean; the
      // canvas prefetches it on mount, making this await effectively instant.
      await import("#editor/document.ts");
      await customElements.whenDefined("document-view");
      await this.collaboration?.joinUntilReady();
      if (this.disposed) return;
      this.status = "ready";
    } catch (error) {
      if (this.disposed) return;
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderQueued || this.disposed) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    render(this.template(), this);
  }

  /** Attaches to the `<document-view>` once lit has created it. */
  private adoptView(view: DocumentViewElement | undefined): void {
    if (this.view === view) return;

    this.view = view ?? null;
    if (!view) return;

    view.setEditorEnabled?.(true, this.collaboration?.ydoc());
    this.setEditor(view.editorInstance);
    this.pushCollaborationState();

    view.addEventListener("editor-ready", (event) => {
      this.setEditor((event as CustomEvent<{ editor: Editor }>).detail.editor);
    });
    view.addEventListener("editor-destroyed", () => this.setEditor(undefined));
  }

  private pushCollaborationState(): void {
    this.view?.setPresenceProfiles?.(this.collaboration?.presenceProfiles() ?? []);
    this.view?.setLocalAppearance?.(this.collaboration?.appearance());
  }

  private broadcastEditorPresence = (): void => {
    const state = currentEditorPresenceState(this.editor);
    this.collaboration?.setPresenceState(state);
    // Join the presence room only once the editor actually holds focus.
    if (state.focused) void this.collaboration?.setupPresence();
    this.collaboration?.updatePresence();
  };

  private setEditor(next: Editor | undefined): void {
    if (this.editor === next) return;

    this.leaveEditorSubscriptions?.();
    this.leaveEditorSubscriptions = null;
    this.editor = next;
    if (!next) return;

    this.applyPendingTaskToggle(next);

    const events = ["focus", "blur", "selectionUpdate", "transaction"] as const;
    for (const event of events) next.on(event, this.broadcastEditorPresence);
    this.broadcastEditorPresence();

    this.leaveEditorSubscriptions = () => {
      for (const event of events) next.off(event, this.broadcastEditorPresence);
    };
  }

  /**
   * Toggles the Nth task item, matching the checkbox the user clicked on the
   * read-only card. Task items render one checkbox each in document order, so
   * the ordinal maps directly onto the editor.
   */
  private applyPendingTaskToggle(editor: Editor): void {
    const index = this.pendingTaskToggle;
    this.pendingTaskToggle = null;
    if (index === null || index < 0) return;

    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "taskItem") positions.push(pos);
    });
    const pos = positions[index];
    if (pos === undefined) return;

    editor
      .chain()
      .command(({ tr }) => {
        const node = tr.doc.nodeAt(pos);
        if (node?.type.name !== "taskItem") return false;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked });
        return true;
      })
      .run();
  }

  private onKeydown = (event: KeyboardEvent): void => {
    // Keep typing from triggering canvas shortcuts (tool switches, Delete).
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      // Collaborative edits persist automatically; swallow the save dialog.
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") this.emit("exit-edit");
  };

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Read by the host's `finish` callback to persist the edited preview. */
  getHtml(): string | null {
    return this.editor?.getHTML() ?? null;
  }

  /** Explicit teardown — see `disconnectedCallback`. */
  destroy(): void {
    this.disposed = true;
    this.setEditor(undefined);
    this.view?.setEditorEnabled?.(false);
    this.unsubscribeCollaboration?.();
    this.unsubscribeCollaboration = null;
    this.#collaboration?.dispose();
    this.#collaboration = null;
  }

  private template() {
    const stop = (event: Event) => event.stopPropagation();

    return html`
      <div
        class="canvas-doc-editor"
        @pointerdown=${stop}
        @dblclick=${stop}
        @contextmenu=${stop}
        @wheel=${stop}
        @keydown=${this.onKeydown}
        @keyup=${stop}
        @copy=${stop}
        @cut=${stop}
        @paste=${stop}
      >
        <div
          class="editor-header"
          @pointerdown=${(event: PointerEvent) => {
            event.stopPropagation();
            this.emit("drag-start", event);
          }}
        >
          <span class="svg-icon icon" aria-hidden="true">${unsafeSVG(documentIcon)}</span>
          <span class="title-wrap"><span class="title">${this.documentTitle}</span></span>
          <button
            type="button"
            class="done"
            @pointerdown=${stop}
            @click=${() => this.emit("exit-edit")}
          >
            Done
          </button>
        </div>
        ${
          this.headerImage
            ? html`<div class="editor-header-image-frame">
                <img
                  class="editor-header-image"
                  src=${this.headerImage}
                  alt=""
                  draggable="false"
                />
              </div>`
            : ""
        }
        <div class="editor-body">
          ${
            this.status === "connecting"
              ? html`<p class="editor-hint">Connecting…</p>`
              : this.status === "error"
                ? html`<p class="editor-hint">
                    ${this.errorMessage || "Unable to open the editor."}
                  </p>`
                : html`<document-view
                    space-id=${this.spaceId}
                    document-id=${this.documentId}
                    ${ref((element) => this.adoptView(element as DocumentViewElement))}
                  ></document-view>`
          }
        </div>
      </div>
    `;
  }
}

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("canvas-document-editor")
) {
  customElements.define("canvas-document-editor", CanvasDocumentEditorElement);
}
