import { render } from "lit-html";
import type * as Y from "yjs";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import type { CanvasView } from "./CanvasController.ts";
import { type CanvasController, createCanvasController } from "./CanvasController.ts";
import type { CanvasDomRefs } from "./view/CanvasView.ts";
import "./view/CanvasPresenceCursorElement.ts";
// The stylesheet for the light-DOM tree this element builds. Imported here
// rather than in the controller: the controller is logic, and is only ever
// loaded through this module anyway.
import "./css/canvas.css";
import type { CanvasCollaborationFactory } from "./document/collaboration.ts";
import { HostElement } from "./extensions/CanvasElementBase.ts";
import type { DocumentPreviewSource } from "./extensions/documentLink.ts";
import type { CanvasUploader } from "./extensions/media.ts";
import type { CanvasElementExtension, CanvasToolExtension } from "./extensions/types.ts";
import { canvasTemplate } from "./view/template.ts";

export const canvasHostTag = "vektor-canvas";

/**
 * Events after which the canvas may need to draw.
 *
 * Deliberately broad: a spurious frame is a no-op diff, a missing one is a
 * canvas that stopped responding.
 */
const INPUT_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "click",
  "dblclick",
  "contextmenu",
  "keydown",
  "keyup",
  "wheel",
  "input",
  "change",
  "focusin",
  "focusout",
  "drop",
  "dragover",
  "paste",
] as const;

/**
 * The canvas host, as a framework-free custom element.
 *
 * Follows the editor's precedent — `DocumentView extends HTMLElement`
 * (`editor/document.ts`) — and the lifecycle `CanvasElementBase` already
 * implements for the element bodies inside the canvas: light DOM, build once,
 * patch on change, coalesce work onto a microtask.
 *
 * Why the canvas sits outside the framework: the element bodies are already
 * custom elements, and the host is 3,700 lines of viewport maths, pointer
 * handling and Yjs wiring that needs no framework.
 *
 * Everything the canvas cannot resolve for itself — the current user, the space
 * role, the document's grid setting, an uploader — arrives as a property. The
 * canvas never reaches back into the app, which is what lets it outlive the
 * app's framework.
 *
 * Extends `HostElement` rather than `HTMLElement` directly: the class body is
 * evaluated at module load, `HTMLElement` does not exist during SSR, and this
 * module is reachable from the server render through the component adapter.
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

  /**
   * Called after every frame this element paints.
   *
   * The canvas is immediate-mode and tracks nothing, so it cannot say *what*
   * changed — only that it drew. Solid chrome outside the element turns that
   * into a signal and lets its own memos decide whether anything it renders
   * actually moved.
   */
  onframe: (() => void) | undefined;

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
   * A host property changed, so the canvas needs another frame.
   *
   * Host properties sit on the element rather than in the controller's state
   * proxy, so writing one does not mark the canvas dirty by itself.
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

    this.watchInput();

    // First paint has to happen before mount: the controller measures the
    // viewport and attaches observers to the canvas layers, and none of those
    // elements exist until the template has run once.
    this.renderNow();
    this.controller.mount();
    this.renderNow();
  }

  /**
   * Input, update, draw.
   *
   * The canvas keeps no track of what a handler touched, so anything that can
   * be an interaction asks for a frame. One listener per event type on the host
   * replaces a redraw call at every write site, and cannot be forgotten by the
   * next person to add a handler.
   *
   * Capture phase for two reasons: chrome inside the canvas calls
   * `stopPropagation` to keep clicks away from the viewport, which would hide
   * those interactions from a bubble listener; and the render is batched onto a
   * microtask, so asking for it before the handlers run still paints after
   * them.
   */
  private watchInput(): void {
    for (const type of INPUT_EVENTS) {
      this.addEventListener(type, this.boundRequestRender, { capture: true });
    }
  }

  private readonly boundRequestRender = () => this.requestRender();

  /**
   * Ask for a frame from outside the element.
   *
   * The Solid chrome renders beside this element, not inside it, so its clicks
   * never reach the capture listener above — it says so itself instead.
   */
  requestFrame(): void {
    this.requestRender();
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
    this.onframe?.();
  }

  /**
   * The view model the chrome reads.
   *
   * Null until the element starts. The Solid chrome rendered beside this
   * element reads state through here and calls commands on it, the same object
   * the lit template inside gets.
   */
  get view(): CanvasView | null {
    return this.controller?.view ?? null;
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
