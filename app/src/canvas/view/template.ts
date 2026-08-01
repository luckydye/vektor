import { html, nothing, type TemplateResult } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";
import { html as staticHtml, unsafeStatic } from "lit-html/static.js";
import {
  copyIcon,
  cutIcon,
  deleteElementIcon,
  lockElementIcon,
  pasteIcon,
  unlockElementIcon,
  uploadFileIcon,
} from "#assets/icons.ts";
import type { CanvasView } from "#canvas/CanvasController.ts";
import type { CanvasShape } from "#canvas/extensions/types.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { t } from "#utils/lang.ts";
import type { CanvasDomRefs } from "./CanvasView.ts";

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
                ${svgIcon(lockElementIcon, "svg-icon canvas-tool-icon")}
              </button>
              <span class="canvas-divider"></span>
              <button
                type="button"
                class="canvas-tool"
                aria-label=${t("Copy")}
                @click=${run(() => view.copySelectionToClipboard())}
              >
                ${svgIcon(copyIcon, "svg-icon canvas-tool-icon")}
              </button>
              <button
                type="button"
                class="canvas-tool"
                aria-label=${t("Cut")}
                @click=${run(() => view.cutSelectionToClipboard())}
              >
                ${svgIcon(cutIcon, "svg-icon canvas-tool-icon")}
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
        ${svgIcon(pasteIcon, "svg-icon canvas-tool-icon")}
      </button>
      <button
        type="button"
        class="canvas-tool"
        aria-label=${t("Upload file")}
        @click=${() => view.uploadFromContextMenu()}
      >
        ${svgIcon(uploadFileIcon, "svg-icon canvas-tool-icon")}
      </button>
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
                ${svgIcon(deleteElementIcon, "svg-icon canvas-tool-icon")}
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
                ${svgIcon(unlockElementIcon)}
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
