import type * as Y from "yjs";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import type { CanvasElementExtension, CanvasToolExtension } from "./extensions/types.ts";

export const canvasHostTag = "vektor-canvas";

/**
 * The canvas host, as a framework-free custom element.
 *
 * Follows the editor's precedent — `DocumentView extends HTMLElement`
 * (`editor/document.ts`) — and the lifecycle `CanvasElementBase` already
 * implements for the 13 element bodies inside the canvas: light DOM, build once
 * in `mount()`, patch in `update()`, coalesce work onto a microtask.
 *
 * Why the canvas leaves the framework entirely (plan section 6): the element
 * bodies are already custom elements, the host is 3,700 lines of viewport
 * maths, pointer handling and Yjs wiring that needs no framework, and doing it
 * before the Solid port means one framework in the tree at a time rather than
 * two coexisting for the whole migration.
 *
 * This is the skeleton. It owns the lifecycle and the property surface; the
 * viewport, rendering and interaction move into it in the following tickets,
 * and `Canvas.vue` remains the live host until they do.
 */
export class CanvasHostElement extends HTMLElement {
  private root: HTMLDivElement | null = null;
  private mounted = false;
  private renderQueued = false;

  private spaceIdValue = "";
  private documentIdValue: string | undefined;
  private ydocValue: Y.Doc | undefined;
  private presenceProfilesValue: CollaborationPresenceProfile<CanvasPresenceState>[] = [];
  private extensionsValue: readonly CanvasElementExtension[] = [];
  private toolsValue: readonly CanvasToolExtension[] = [];

  /**
   * Properties, not attributes.
   *
   * A `Y.Doc` and an extension list cannot be serialised into markup, so the
   * host sets these as DOM properties. Single-word names on purpose — the same
   * reason `CanvasElementBase` uses `shape`/`context`/`data`: Vue lowercases
   * kebab-cased bindings on an unknown element, so a camelCase property would
   * silently never be written while the port still runs through a Vue template.
   */
  set spaceid(value: string) {
    if (this.spaceIdValue === value) return;
    this.spaceIdValue = value;
    this.scheduleRender();
  }
  get spaceid(): string {
    return this.spaceIdValue;
  }

  set documentid(value: string | undefined) {
    if (this.documentIdValue === value) return;
    this.documentIdValue = value;
    this.scheduleRender();
  }
  get documentid(): string | undefined {
    return this.documentIdValue;
  }

  set ydoc(value: Y.Doc | undefined) {
    if (this.ydocValue === value) return;
    this.ydocValue = value;
    this.scheduleRender();
  }
  get ydoc(): Y.Doc | undefined {
    return this.ydocValue;
  }

  set presence(value: CollaborationPresenceProfile<CanvasPresenceState>[] | undefined) {
    this.presenceProfilesValue = value ?? [];
    this.scheduleRender();
  }
  get presence(): CollaborationPresenceProfile<CanvasPresenceState>[] {
    return this.presenceProfilesValue;
  }

  set extensions(value: readonly CanvasElementExtension[] | undefined) {
    this.extensionsValue = value ?? [];
    this.scheduleRender();
  }
  get extensions(): readonly CanvasElementExtension[] {
    return this.extensionsValue;
  }

  set tools(value: readonly CanvasToolExtension[] | undefined) {
    this.toolsValue = value ?? [];
    this.scheduleRender();
  }
  get tools(): readonly CanvasToolExtension[] {
    return this.toolsValue;
  }

  connectedCallback(): void {
    this.flush();
  }

  /**
   * Deliberately does **not** reset `mounted` or clear children.
   *
   * A parent reordering its children disconnects and reconnects this element,
   * and rebuilding on every reconnect duplicates the canvas body — the same
   * trap `CanvasElementBase` documents. Teardown belongs in an explicit
   * `destroy()`, not in a lifecycle callback that fires on a move.
   */
  disconnectedCallback(): void {}

  private scheduleRender(): void {
    if (!this.isConnected || this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.mounted) {
      this.mount();
      this.mounted = true;
      return;
    }
    this.update();
  }

  /** Builds the canvas shell once. Idempotent: any stray children are cleared. */
  private mount(): void {
    this.replaceChildren();

    const root = document.createElement("div");
    root.className = "canvas-root";
    root.dataset.canvasRoot = "";
    this.root = root;
    this.replaceChildren(root);

    this.update();
  }

  /** Patches the existing shell in place. Never rebuilds it. */
  private update(): void {
    if (!this.root) return;
    this.root.dataset.spaceId = this.spaceIdValue;
    if (this.documentIdValue) this.root.dataset.documentId = this.documentIdValue;
    else delete this.root.dataset.documentId;
    this.root.dataset.ready = this.ydocValue ? "true" : "false";
  }

  /** Explicit teardown. Not called on disconnect — see `disconnectedCallback`. */
  destroy(): void {
    this.replaceChildren();
    this.root = null;
    this.mounted = false;
  }
}

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get(canvasHostTag)
) {
  customElements.define(canvasHostTag, CanvasHostElement);
}
