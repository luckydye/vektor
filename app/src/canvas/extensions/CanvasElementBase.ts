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
  // True when the pointer interaction that produced the current click was
  // actually a drag — file/link cards use it to suppress navigation after a
  // reposition (the host's `dragMoved` flag).
  wasDragged: () => boolean;

  // --- host services ---
  // Element bodies act on the canvas through these instead of emitting
  // type-specific events the host has to interpret. The host owns the shape
  // store, selection, and singleton chrome; extensions drive them.
  setText: (shapeId: string, text: string) => void;
  removeShape: (shapeId: string) => void;
  selectShape: (shapeId: string) => void;
  // Retarget the shared canvas formatting toolbar at a focused editor (or clear
  // it with null). The toolbar is a host-level singleton.
  setFormattingEditor: (editor: unknown | null) => void;
}

// `class extends HTMLElement` is evaluated at module load. HTMLElement is
// undefined during SSR, so fall back to a dummy base there; the guarded
// customElements.define() calls never run on the server anyway. Exported so
// standalone canvas custom elements (e.g. twitterEmbed) share the guard.
export const HostElement: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

// Event names elements dispatch upward. The host binds these on the element tag
// (e.g. `@request-drag`). Kept as a const map so element and host agree.
/**
 * Wire a pointerdown on `element` to `emit`, stopping propagation first so it
 * never reaches the viewport marquee/deselect (the old `@pointerdown.stop`).
 */
export function dragOnPointerDown(
  element: HTMLElement,
  emit: (event: PointerEvent) => void,
) {
  element.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    emit(event);
  });
}

// Custom-event names elements dispatch upward for the host to handle (bound on
// the element tag, e.g. `@request-drag`). Only events the host interprets go
// here; editor content/focus/blur are handled inside the elements via services.
export const CANVAS_ELEMENT_EVENTS = {
  requestDrag: "request-drag",
  documentClick: "document-click",
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
  protected services: CanvasElementContext | null = null;
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

  // Single-word property name on purpose: Vue's HTML template lowercases kebab
  // prop bindings, so a `:context.prop` binding reaches this setter while a
  // camelCase/kebab one (e.g. canvasContext / canvas-context) silently would not.
  set context(value: CanvasElementContext | null) {
    this.services = value;
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

  // Deliberately does NOT reset `mounted` or clear children. Vue reorders
  // shapes by remove+reinsert (e.g. a drag bumps updatedAt, which re-sorts the
  // shapes array), firing disconnect→connect on this same element instance.
  // Rebuilding would duplicate our imperatively-created children; keeping the
  // built DOM lets the element — and any child custom elements, which restore
  // their own state on reconnect — survive the move intact. On a real removal
  // (shape deleted) the element is dropped and garbage-collected, and its child
  // custom elements clean themselves up via their own disconnectedCallback.
  disconnectedCallback() {}

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
      // Clear any stray children before building so a mount is always
      // idempotent, even if one somehow runs on an already-populated element.
      this.replaceChildren();
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
  // Text has nothing anchoring it, so an empty one is removed on blur; notes
  // keep their box.
  protected abstract readonly removeWhenEmpty: boolean;

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

    // Drive the host services directly rather than emitting type-specific events
    // for the host to interpret.
    editor.addEventListener("content-change", (event) => {
      const id = this.shapeData?.id;
      if (id) this.services?.setText(id, (event as CustomEvent).detail);
    });
    editor.addEventListener("editor-focus", () => {
      const id = this.shapeData?.id;
      if (!id) return;
      this.services?.selectShape(id);
      this.services?.setFormattingEditor(editor.editorInstance);
    });
    editor.addEventListener("editor-blur", (event) => {
      const id = this.shapeData?.id;
      if (!id) return;
      const value = String((event as CustomEvent).detail ?? "");
      if (this.removeWhenEmpty && value.trim() === "") this.services?.removeShape(id);
    });

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
}
