import "#editor/elements/rich-text-editor.ts";
import type { RichTextEditorElementApi } from "#editor/elements/rich-text-editor.ts";
import type { TranslationKey } from "#utils/lang.ts";
import type { CanvasShape } from "./types.ts";

// Stable helpers/data the host hands to every element once via the `context`
// property. Per-shape reactive values flow through `shape` / `data` instead;
// element → host communication is done with bubbling CustomEvents (see
// CANVAS_ELEMENT_EVENTS), mirroring how <rich-text-editor> reports upward.
export interface CanvasElementContext {
  t: (key: TranslationKey) => string;
  isGifSrc: (src: string) => boolean;
  getDomainFromUrl: (url: string) => string;
  spaceId: string;
}

// `class extends HTMLElement` is evaluated at module load. HTMLElement is
// undefined during SSR, so fall back to a dummy base there; the guarded
// customElements.define() calls never run on the server anyway.
const HostElement: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

// Event names elements dispatch upward. The host binds these on the element tag
// (e.g. `@request-drag`). Kept as a const map so element and host agree.
export const CANVAS_ELEMENT_EVENTS = {
  requestDrag: "request-drag",
  contentChange: "content-change",
  editorFocus: "editor-focus",
  editorBlur: "editor-blur",
  fileClick: "file-click",
  documentClick: "document-click",
  openDocument: "open-document",
  resize: "element-resize",
} as const;

/**
 * Base class for canvas element custom elements. Subclasses build their DOM
 * once in `mount()` and patch it in `update()` — never rebuilding on every
 * property change, so embedded editors keep their focus/selection state.
 *
 * The element renders into its own light DOM (no shadow root) and sets
 * `display: contents` so the existing global canvas CSS keeps matching exactly
 * as if the markup were still inline in Canvas.vue.
 */
export abstract class CanvasElementBase extends HostElement {
  protected shapeData: CanvasShape | null = null;
  protected context: CanvasElementContext | null = null;
  protected extra: unknown = null;
  private mounted = false;
  private renderQueued = false;

  set shape(value: CanvasShape | null) {
    this.shapeData = value;
    this.scheduleRender();
  }
  get shape(): CanvasShape | null {
    return this.shapeData;
  }

  set canvasContext(value: CanvasElementContext | null) {
    this.context = value;
    this.scheduleRender();
  }

  // Per-type reactive view model (preview state, editing flags, …). Named
  // `data` on the property so the host binds `:data.prop`.
  set data(value: unknown) {
    this.extra = value;
    this.scheduleRender();
  }

  connectedCallback() {
    this.style.display = "contents";
    this.flush();
  }

  disconnectedCallback() {
    if (this.mounted) this.teardown();
    this.mounted = false;
  }

  // Coalesce the several property writes Vue performs per update into one
  // render, on a microtask so there is no visible lag.
  private scheduleRender() {
    if (!this.isConnected || this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.flush();
    });
  }

  private flush() {
    if (!this.shapeData) return;
    if (!this.mounted) {
      this.mount();
      this.mounted = true;
    }
    this.update();
  }

  protected emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  // Build child DOM once. `this.shapeData` is guaranteed non-null here.
  protected abstract mount(): void;
  // Patch child DOM from the current shape/data. Called after every mount and
  // on every subsequent property change.
  protected abstract update(): void;
  // Optional cleanup on disconnect.
  protected teardown(): void {}
}

/**
 * Shared base for the rich-text element types (note, text), which both embed a
 * <rich-text-editor>. The editor is created once and only its `value` is
 * patched, so typing/selection state survives shape updates.
 */
export abstract class CanvasRichTextElement extends CanvasElementBase {
  // Note shows a dedicated drag grip; text drags from the editor body itself
  // (only when not being edited).
  protected abstract readonly showHandle: boolean;
  protected abstract readonly dragFromEditor: boolean;

  private editorEl: RichTextEditorElementApi | null = null;

  protected mount() {
    if (this.showHandle) {
      const handle = document.createElement("div");
      handle.className = "canvas-shape-handle";
      handle.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event);
      });
      this.appendChild(handle);
    }

    const editor = document.createElement("rich-text-editor") as RichTextEditorElementApi;
    editor.className = "canvas-shape-textwrap";
    editor.setAttribute("headings", "");
    // Set before connect so the editor mounts with the right initial content.
    editor.value = this.shapeData?.text ?? "";
    // The editor's own content-change / editor-focus / editor-blur events are
    // composed+bubbling, so they pass through this wrapper to the host as-is —
    // no re-dispatch needed, and event.target stays the <rich-text-editor> so
    // the shared formatting toolbar can read its editorInstance.
    //
    // Match the original template: pointerdown on the editor always stops
    // propagation (so it never reaches the viewport marquee/deselect); text
    // additionally begins a drag when it isn't focused for editing.
    editor.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (
        this.dragFromEditor &&
        !(event.currentTarget as Element).matches(":focus-within")
      ) {
        this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event);
      }
    });
    this.appendChild(editor);
    this.editorEl = editor;
  }

  protected update() {
    if (this.editorEl && this.shapeData) this.editorEl.value = this.shapeData.text;
  }

  protected teardown() {
    this.editorEl = null;
  }
}
