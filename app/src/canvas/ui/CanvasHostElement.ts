import { render } from "lit-html";
import type * as Y from "yjs";
import type { CanvasDomRefs, CanvasView } from "#canvas/runtime/controller.ts";
import {
  type CanvasController,
  createCanvasController,
} from "#canvas/runtime/controller.ts";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import "#canvas/ui/PresenceCursorElement.ts";
// The stylesheet for the light-DOM tree this element builds. Imported here
// rather than in the controller: the controller is logic, and is only ever
// loaded through this module anyway.
import "#canvas/ui/canvas.css";
import { html, nothing, type TemplateResult } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";
import { html as staticHtml, unsafeStatic } from "lit-html/static.js";
import type { CanvasCollaborationFactory } from "#canvas/document/collaboration.ts";
import type { DocumentPreviewSource } from "#canvas/extensions/documentLink.ts";
import type { CanvasUploader } from "#canvas/extensions/media.ts";
import { HostElement } from "#canvas/runtime/elementBase.ts";
import type {
  CanvasElementExtension,
  CanvasShape,
  CanvasToolExtension,
} from "#canvas/runtime/extensionApi.ts";
import { iconMarkup } from "#components/Icon.tsx";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { t } from "#utils/lang.ts";

export const canvasHostTag = "vektor-canvas";

// Deliberately broad: a spurious frame is a no-op diff, a missing one is a
// canvas that stopped responding.
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
   * Properties, not attributes: a `Y.Doc` cannot be serialised into markup.
   * Single-word names because a template that lowercases kebab-cased bindings
   * reaches a single-word setter and silently misses a camelCase one.
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
   * One listener per event type, so no write site can forget to ask for a frame.
   * Capture phase: chrome inside the canvas calls `stopPropagation`, which would
   * hide those interactions from a bubble listener, and the render is batched
   * onto a microtask so asking early still paints after the handlers.
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

// --- the lit template ------------------------------------------------------
// Here because `renderNow()` above is its only caller.

/**
 * The canvas shell, as lit-html.
 *
 * Note that `<canvas-presence-cursor>` takes `x`/`y`/`name`/`companion-id` as
 * *attributes* — it declares them in `observedAttributes` and reads them with
 * `getAttribute`. A lit `.x=` property binding sets a field it never looks at,
 * which leaves every cursor at the origin and its cosmetic companion with
 * nothing to follow.
 *
 * Two rendering choices here are load-bearing:
 *
 * 1. Shape articles are rendered with `repeat()` keyed by shape id. lit's
 *    default list handling patches by index, which would move a shape's data
 *    onto a different element on every reorder — and shapes reorder constantly,
 *    since a drag bumps `updatedAt`. `repeat()` moves the DOM node instead,
 *    which is what keeps the element bodies (and their focus, editors and
 *    upload state) alive across a move.
 * 2. Varying element tags go through `lit-html/static.js`. A lit template is
 *    identified by its string literal, so a tag name that varies cannot be an
 *    ordinary binding — `unsafeStatic` makes the tag part of the literal, and a
 *    different tag produces a different template and therefore a fresh element,
 *    which is the required behaviour when a shape changes type.
 */

const svgIcon = (markup: string, className = "svg-icon") =>
  html`<div class=${className} aria-hidden="true">${unsafeSVG(markup)}</div>`;

/** Keeps chrome clicks away from the viewport marquee. */
const stopPointer = (event: Event) => event.stopPropagation();

/**
 * One shape article.
 *
 * The two branches build a differently-tagged custom element, so each is wrapped
 * built with a static tag, so a shape that changes type gets a new element
 * rather than a `<canvas-note>` patched into a `<canvas-link>`.
 */
function shapeArticle(view: CanvasView, shape: CanvasShape) {
  const tag = view.elementTagForShape(shape);
  const session = view.state.activeEditSession;

  let body: unknown = nothing;
  if (tag) {
    const element = unsafeStatic(tag);
    body = staticHtml`<${element}
      .shape=${shape}
      .context=${view.hostContext()}
      .data=${view.elementDataForShape(shape)}
      @request-drag=${(event: Event) =>
        view.startShapeDrag(shape, (event as CustomEvent).detail)}
      @document-click=${(event: Event) =>
        view.onElementActivate(shape, (event as CustomEvent).detail)}
      @open-document=${(event: Event) => view.onElementOpen(shape, event)}
    ></${element}>`;
  } else if (session?.shapeId === shape.id && session.tag) {
    // `elementTagForShape` returns null only while a card is being edited
    // inline: the host swaps in its own editor, which depends on host editing
    // state (save/exit orchestration) the element cannot carry.
    const element = unsafeStatic(session.tag);
    body = staticHtml`<${element}
      class=${ifDefined(session.className)}
      ${ref((instance) => {
        // The session's props are type-erased and vary per editor, so they are
        // assigned rather than bound — lit has no spread for that.
        if (instance) Object.assign(instance, session.props ?? {});
        view.setActiveEditorRef(instance ?? null);
      })}
      @drag-start=${(event: Event) =>
        view.startShapeDrag(shape, (event as CustomEvent).detail[0])}
      @exit-edit=${() => view.stopActiveEdit()}
    ></${element}>`;
  }

  return html`
    <article
      class=${classMap({
        "canvas-shape": true,
        [shape.type]: true,
        selected: view.state.selectedShapeIds.has(shape.id),
      })}
      style=${styleMap(view.articleStyle(shape))}
      data-shape-id=${shape.id}
      hidden=${ifDefined(view.isBrowserFindTarget(shape) ? "until-found" : undefined)}
    >
      ${body}
    </article>
  `;
}

/** The section-title editor, whose tag the extension chooses. */
function chromeEditor(view: CanvasView, shape: CanvasShape) {
  const tag = view.editorTagForShape(shape);
  if (!tag) return nothing;
  const element = unsafeStatic(tag);
  return staticHtml`<${element}
    data-editor-shape-id=${shape.id}
    .shape=${shape}
    .context=${view.hostContext()}
    @finish-edit=${() => view.finishChromeEditing()}
  ></${element}>`;
}

function transformControls(view: CanvasView) {
  const transformShape = view.selectedTransformShape();
  const resizeShape = view.selectedResizeOnlyShape();
  const scalable = view.selectedScalableSelection();
  const stroke = view.selectedBasicShapeStroke();
  const strokeControls = view.selectedBasicShapeStrokeControls();

  return html`
    ${
      transformShape
        ? html`<div class="canvas-transform-controls">
            <button
              type="button"
              class="canvas-transform-handle canvas-rotate-handle"
              aria-label=${`${t("Rotate")} ${transformShape.type}`}
              style=${styleMap(handleAt(view.transformControlPositions(transformShape).rotation))}
              @pointerdown=${(event: PointerEvent) => {
                event.stopPropagation();
                view.startShapeRotation(transformShape, event);
              }}
            >
              ↻
            </button>
            <button
              type="button"
              class="canvas-transform-handle canvas-resize-handle"
              aria-label=${`${t("Resize")} ${transformShape.type}`}
              style=${styleMap({
                ...handleAt(view.transformControlPositions(transformShape).resize),
                transform: `translate(-50%, -50%) rotate(${transformShape.frame.rotation}deg)`,
              })}
              @pointerdown=${(event: PointerEvent) => {
                event.stopPropagation();
                view.startShapeResize(transformShape, event);
              }}
            ></button>
          </div>`
        : nothing
    }
    ${
      resizeShape
        ? html`<div class="canvas-transform-controls">
            <button
              type="button"
              class="canvas-transform-handle canvas-resize-handle"
              aria-label=${`${t("Resize")} ${resizeShape.type}`}
              style=${styleMap({
                ...handleAt(view.transformControlPositions(resizeShape).resize),
                transform: `translate(-50%, -50%) rotate(${resizeShape.frame.rotation}deg)`,
              })}
              @pointerdown=${(event: PointerEvent) => {
                event.stopPropagation();
                view.startShapeResize(resizeShape, event);
              }}
            ></button>
          </div>`
        : nothing
    }
    ${
      scalable
        ? html`<div class="canvas-transform-controls">
            <button
              type="button"
              class="canvas-transform-handle canvas-resize-handle"
              aria-label=${t("Scale selection")}
              style=${styleMap(handleAt(view.selectionScaleControlPosition(scalable.bounds)))}
              @pointerdown=${(event: PointerEvent) => {
                event.stopPropagation();
                view.startSelectionScale(scalable, event);
              }}
            ></button>
          </div>`
        : nothing
    }
    ${
      stroke && strokeControls
        ? html`<div class="canvas-transform-controls">
            <button
              type="button"
              class="canvas-transform-handle canvas-rotate-handle"
              aria-label=${`${t("Rotate")} ${t("Shape")}`}
              style=${styleMap(handleAt(strokeControls.rotation))}
              @pointerdown=${(event: PointerEvent) => {
                event.stopPropagation();
                view.startStrokeRotation(stroke, event);
              }}
            >
              ↻
            </button>
            <button
              type="button"
              class="canvas-transform-handle canvas-resize-handle"
              aria-label=${`${t("Resize")} ${t("Shape")}`}
              style=${styleMap({
                ...handleAt(strokeControls.resize),
                transform: `translate(-50%, -50%) rotate(${stroke.rotation || 0}deg)`,
              })}
              @pointerdown=${(event: PointerEvent) => {
                event.stopPropagation();
                view.startStrokeResize(stroke, event);
              }}
            ></button>
          </div>`
        : nothing
    }
  `;
}

const handleAt = (point: { x: number; y: number }) => ({
  left: `${point.x}px`,
  top: `${point.y}px`,
});

function contextMenu(view: CanvasView) {
  const position = view.state.contextMenuPos;
  if (!position) return nothing;
  const hasSelection =
    view.state.selectedShapeIds.size > 0 || view.state.selectedStrokeIds.size > 0;
  // Per-type entries contributed by the selected shape's extension. Read once
  // per open rather than per button, since the hook may inspect live state.
  const extensionEntries = view.contextMenuEntries();
  const run = (action: () => void) => () => {
    action();
    view.closeContextMenu();
  };

  return html`
    <div
      class="canvas-context-menu"
      style=${styleMap({ transform: `translate(${position.x}px, ${position.y}px)` })}
      @pointerdown=${stopPointer}
    >
      ${
        hasSelection
          ? html`
              <button
                type="button"
                class="canvas-tool"
                aria-label=${t("Lock")}
                @click=${run(() => view.lockSelectedElements())}
              >
                ${svgIcon(iconMarkup("lock-element"), "svg-icon canvas-tool-icon")}
              </button>
              <span class="canvas-divider"></span>
              <button
                type="button"
                class="canvas-tool"
                aria-label=${t("Copy")}
                @click=${run(() => view.copySelectionToClipboard())}
              >
                ${svgIcon(iconMarkup("copy"), "svg-icon canvas-tool-icon")}
              </button>
              <button
                type="button"
                class="canvas-tool"
                aria-label=${t("Cut")}
                @click=${run(() => view.cutSelectionToClipboard())}
              >
                ${svgIcon(iconMarkup("cut"), "svg-icon canvas-tool-icon")}
              </button>
              <span class="canvas-divider"></span>
            `
          : nothing
      }
      <button
        type="button"
        class="canvas-tool"
        aria-label=${t("Paste")}
        @click=${() => view.pasteFromContextMenu()}
      >
        ${svgIcon(iconMarkup("paste"), "svg-icon canvas-tool-icon")}
      </button>
      <button
        type="button"
        class="canvas-tool"
        aria-label=${t("Upload file")}
        @click=${() => view.uploadFromContextMenu()}
      >
        ${svgIcon(iconMarkup("upload-file"), "svg-icon canvas-tool-icon")}
      </button>
      ${
        extensionEntries.length > 0
          ? html`
              <span class="canvas-divider"></span>
              ${extensionEntries.map(
                (entry) => html`
                  <button
                    type="button"
                    class=${entry.danger ? "canvas-tool danger" : "canvas-tool"}
                    aria-label=${t(entry.label)}
                    @click=${run(() => entry.run())}
                  >
                    ${svgIcon(entry.icon, "svg-icon canvas-tool-icon")}
                  </button>
                `,
              )}
            `
          : nothing
      }
      ${
        hasSelection
          ? html`
              <span class="canvas-divider"></span>
              <button
                type="button"
                class="canvas-tool danger"
                aria-label=${t("Delete")}
                @click=${run(() => view.deleteSelectedShape())}
              >
                ${svgIcon(iconMarkup("delete-element"), "svg-icon canvas-tool-icon")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

export function canvasTemplate(view: CanvasView, dom: CanvasDomRefs): TemplateResult {
  const transform = view.transform();
  const chromeShape = view.editingChromeShape();
  const lockPosition = view.hoveredLockedElementPosition();
  const localPointer = view.state.localPointerScreen;
  const marquee = view.state.marqueeRect;

  return html`
    <div class=${classMap({ "canvas-root": true, "is-dark": view.state.isDarkMode })}>
      <div
        class="canvas-viewport"
        tabindex="-1"
        style=${styleMap({ cursor: view.viewportCursor() })}
        ${ref((element) => {
          dom.viewport = (element as HTMLElement) ?? null;
        })}
        @contextmenu=${(event: MouseEvent) => view.handleContextMenu(event)}
        @pointerdown=${(event: PointerEvent) => view.handleViewportPointerDown(event)}
        @pointercancel=${(event: PointerEvent) => view.handlePointerCancel(event)}
        @pointerleave=${() => view.handlePointerLeave()}
        @dblclick=${(event: MouseEvent) => view.handleViewportDoubleClick(event)}
        @dragover=${(event: DragEvent) => view.handleDragOver(event)}
        @drop=${(event: DragEvent) => view.handleDrop(event)}
      >
        <canvas
          class="canvas-scene"
          ${ref((element) => {
            dom.scene = (element as HTMLCanvasElement) ?? null;
          })}
        ></canvas>
        <canvas
          class="canvas-active-ink"
          ${ref((element) => {
            dom.activeInk = (element as HTMLCanvasElement) ?? null;
          })}
        ></canvas>
        <canvas
          class="canvas-selection"
          ${ref((element) => {
            dom.selection = (element as HTMLCanvasElement) ?? null;
          })}
        ></canvas>

        <div
          class="canvas-world"
          style=${styleMap({
            transform: `translate(${transform.dx}px, ${transform.dy}px) scale(${transform.scale})`,
          })}
          @beforematch=${(event: Event) => view.handleBrowserFindMatch(event)}
        >
          ${repeat(
            view.domShapes(),
            (shape) => shape.id,
            (shape) => shapeArticle(view, shape),
          )}
          ${repeat(
            view.uploadPlaceholders(),
            (placeholder) => placeholder.id,
            (placeholder) => html`
              <div
                class="canvas-upload-placeholder"
                style=${styleMap({
                  left: `${placeholder.x}px`,
                  top: `${placeholder.y}px`,
                  width: `${placeholder.width}px`,
                  height: `${placeholder.height}px`,
                })}
              >
                <div class="canvas-upload-spinner" aria-hidden="true"></div>
                <div class="canvas-upload-name">${placeholder.filename}</div>
              </div>
            `,
          )}
        </div>

        ${
          chromeShape
            ? html`<div
                class="canvas-section-title-overlay"
                style=${styleMap({
                  left: `${view.elementChromePosition(chromeShape).x}px`,
                  top: `${view.elementChromePosition(chromeShape).y}px`,
                  width: `${Math.max(1, chromeShape.frame.width * transform.scale)}px`,
                  transform: `rotate(${chromeShape.frame.rotation}deg)`,
                  "--canvas-section-color": chromeShape.style.color,
                })}
                @pointerdown=${stopPointer}
              >
                ${chromeEditor(view, chromeShape)}
              </div>`
            : nothing
        }

        ${transformControls(view)}

        ${
          lockPosition
            ? html`<button
                type="button"
                class="canvas-unlock-button"
                aria-label=${t("Unlock")}
                data-tooltip=${t("Unlock")}
                style=${styleMap({
                  transform: `translate(${lockPosition.x}px, ${lockPosition.y}px) translate(-50%, -50%)`,
                })}
                @pointerdown=${stopPointer}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  view.unlockHoveredElement();
                }}
              >
                ${svgIcon(iconMarkup("unlock-element"))}
              </button>`
            : nothing
        }

        ${
          localPointer && view.cursorCompanion
            ? html`<canvas-presence-cursor
                hide-pointer
                hide-label
                companion-id=${view.cursorCompanion}
                x=${localPointer.x}
                y=${localPointer.y}
                style=${styleMap({ "--presence-color": view.cursorColor })}
              ></canvas-presence-cursor>`
            : nothing
        }

        ${repeat(
          view.remoteCanvasPointerPresences(),
          (presence) => presence.clientId,
          (presence) => {
            const pointer = presence.state?.pointer;
            if (!pointer) return nothing;
            const at = view.worldToScreen(pointer);
            return html`<canvas-presence-cursor
              class=${classMap({ "is-instant": view.state.isCameraMoving })}
              name=${ifDefined(presence.user.name)}
              companion-id=${ifDefined(presence.user.appearance?.cursorCompanion ?? undefined)}
              x=${at.x}
              y=${at.y}
              style=${styleMap({
                "--presence-color":
                  presence.state?.cursorColor ||
                  presence.user.color ||
                  getAvatarColor(presence.user.id),
              })}
            ></canvas-presence-cursor>`;
          },
        )}

        ${
          marquee
            ? html`<div
                class="canvas-marquee"
                style=${styleMap({
                  left: `${marquee.x}px`,
                  top: `${marquee.y}px`,
                  width: `${marquee.width}px`,
                  height: `${marquee.height}px`,
                })}
              ></div>`
            : nothing
        }

        ${contextMenu(view)}
      </div>

      <document-toolbar
        variant="canvas"
        standalone
        ${ref((element) => {
          dom.canvasToolbar = (element as CanvasDomRefs["canvasToolbar"]) ?? null;
        })}
      ></document-toolbar>
    </div>
  `;
}
