import { render } from "lit-html";
import type * as Y from "yjs";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.solid.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import { type CanvasController, createCanvasController } from "./CanvasController.ts";
import type { CanvasDomRefs } from "./CanvasView.ts";
import "./CanvasPresenceCursorElement.ts";
import "./css/canvas.css";
import type { CanvasCollaborationFactory } from "./collaboration.ts";
import { HostElement } from "./extensions/CanvasElementBase.ts";
import type { DocumentPreviewSource } from "./extensions/documentLink.ts";
import type { CanvasUploader } from "./extensions/media.ts";
import type { CanvasElementExtension, CanvasToolExtension } from "./extensions/types.ts";
import { canvasTemplate } from "./template.ts";

export const canvasHostTag = "vektor-canvas";

/**
 * The canvas host, as a framework-free custom element.
 *
 * Follows the editor's precedent — `DocumentView extends HTMLElement`
 * (`editor/document.ts`) — and the lifecycle `CanvasElementBase` already
 * implements for the element bodies inside the canvas: light DOM, build once,
 * patch on change, coalesce work onto a microtask.
 *
 * Why the canvas leaves the framework entirely (plan section 6): the element
 * bodies are already custom elements, the host was 3,700 lines of viewport
 * maths, pointer handling and Yjs wiring that needs no framework, and doing it
 * before the Solid port means one framework in the tree at a time rather than
 * two coexisting for the whole migration.
 *
 * Everything the canvas cannot resolve for itself — the current user, the space
 * role, the document's grid setting, an uploader — arrives as a property. The
 * canvas never reaches back into the app, which is what lets it outlive the
 * app's framework.
 *
 * Extends `HostElement` rather than `HTMLElement` directly: the class body is
 * evaluated at module load, `HTMLElement` does not exist during SSR, and this
 * module is reachable from the server render through the Vue adapter.
 */
export class CanvasHostElement extends HostElement {
  private controller: CanvasController | null = null;
  private renderQueued = false;
  private started = false;

  private readonly dom: CanvasDomRefs = {
    viewport: null,
    scene: null,
    activeInk: null,
    selection: null,
    shapePopover: null,
    canvasToolbar: null,
    activeEditorElement: null,
  };

  /**
   * Properties, not attributes.
   *
   * A `Y.Doc`, an extension list and an uploader cannot be serialised into
   * markup. Single-word names on purpose — the same reason `CanvasElementBase`
   * uses `shape`/`context`/`data`: a template that lowercases kebab-cased
   * bindings reaches a single-word setter and silently misses a camelCase one.
   */
  spaceid = "";
  documentid: string | undefined;
  ydoc: Y.Doc | undefined;
  currentuserid: string | undefined;
  cursorcolor = "#3b82f6";
  cursorcompanion: string | null = null;
  canedit = false;
  gridtype: string | undefined;
  uploadfile: CanvasUploader | undefined;
  createcollaboration: CanvasCollaborationFactory | undefined;
  documents: (() => DocumentPreviewSource[]) | undefined;
  spaces:
    | (() => ReadonlyArray<{ id: string; slug?: string | null }> | undefined)
    | undefined;
  save: ((snapshot: unknown) => Promise<unknown>) | undefined;
  error: ((message: string) => void) | undefined;
  onpresence: ((states: CanvasPresenceState[]) => void) | undefined;

  #presence: CollaborationPresenceProfile<CanvasPresenceState>[] = [];
  #extensions: readonly CanvasElementExtension[] | undefined;
  #tools: readonly CanvasToolExtension[] | undefined;

  set presence(value: CollaborationPresenceProfile<CanvasPresenceState>[] | undefined) {
    this.#presence = value ?? [];
    this.hostPropertyChanged();
  }

  get presence(): CollaborationPresenceProfile<CanvasPresenceState>[] {
    return this.#presence;
  }

  set extensions(value: readonly CanvasElementExtension[] | undefined) {
    this.#extensions = value;
    this.hostPropertyChanged();
  }
  get extensions(): readonly CanvasElementExtension[] | undefined {
    return this.#extensions;
  }

  set tools(value: readonly CanvasToolExtension[] | undefined) {
    this.#tools = value;
    this.hostPropertyChanged();
  }
  get tools(): readonly CanvasToolExtension[] | undefined {
    return this.#tools;
  }

  /**
   * Call after writing several properties at once.
   *
   * Plain fields cannot notify on their own; the shell sets a batch and then
   * says so. The render is still microtask-batched, so saying so twice costs
   * one render.
   */
  changed(): void {
    // Also the start signal. The shell sets `ydoc` after the element is in the
    // document, so `connectedCallback` alone is too early — whichever of the
    // two happens last is the one that starts the canvas.
    this.start();
    this.hostPropertyChanged();
  }

  /**
   * A host property changed, so the controller's cached `derived` values are
   * stale and the canvas needs another frame.
   *
   * Host properties sit on the element rather than in the controller's state
   * proxy, which is what bumps the revision those caches compare against. A
   * bare `requestRender` would repaint from the previous revision's values —
   * that is how remote presence cursors stopped rendering.
   */
  private hostPropertyChanged(): void {
    this.controller?.invalidate();
    this.requestRender();
  }

  connectedCallback(): void {
    this.start();
  }

  /**
   * Deliberately does **not** tear down.
   *
   * A parent reordering its children disconnects and reconnects this element,
   * and rebuilding on every reconnect would destroy the Yjs wiring and every
   * element body inside — the same trap `CanvasElementBase` documents. Teardown
   * belongs in an explicit `destroy()`, not in a callback that fires on a move.
   */
  disconnectedCallback(): void {}

  private start(): void {
    const ydoc = this.ydoc;
    if (this.started || !ydoc) return;
    this.started = true;

    // Getters, not a snapshot: the reactions compare each of these against the
    // previous flush, so a property the shell rewrites later has to be visible
    // through the same reference the controller captured at construction.
    const element = this;
    this.controller = createCanvasController(
      {
        get spaceId() {
          return element.spaceid;
        },
        get documentId() {
          return element.documentid;
        },
        ydoc,
        get presenceProfiles() {
          return element.#presence;
        },
        get extensions() {
          return element.#extensions;
        },
        get tools() {
          return element.#tools;
        },
        get currentUserId() {
          return element.currentuserid;
        },
        get cursorColor() {
          return element.cursorcolor;
        },
        get canEdit() {
          return element.canedit;
        },
        get cursorCompanion() {
          return element.cursorcompanion;
        },
        get gridType() {
          return element.gridtype;
        },
        get documents() {
          return element.documents?.() ?? [];
        },
        get spaces() {
          return element.spaces?.();
        },
        get uploadFile() {
          return element.uploadfile;
        },
        get createCollaboration() {
          return element.createcollaboration;
        },
        save: (snapshot) => element.save?.(snapshot) ?? Promise.resolve(),
        error: (message) => element.error?.(message),
        presenceChanged: (states) => element.onpresence?.(states),
        requestRender: () => element.requestRender(),
      },
      this.dom,
    );

    // First paint has to happen before mount: the controller measures the
    // viewport and attaches observers to the canvas layers, and none of those
    // elements exist until the template has run once.
    this.renderNow();
    this.controller.mount();
    this.renderNow();
  }

  private requestRender(): void {
    if (this.renderQueued || !this.controller) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    const controller = this.controller;
    if (!controller) return;
    controller.flush();
    render(canvasTemplate(controller.view, this.dom), this);
    controller.afterRender();
  }

  /** Explicit teardown. Not called on disconnect — see `disconnectedCallback`. */
  destroy(): void {
    this.controller?.destroy();
    this.controller = null;
    this.started = false;
    this.replaceChildren();
  }
}

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get(canvasHostTag)
) {
  customElements.define(canvasHostTag, CanvasHostElement);
}
