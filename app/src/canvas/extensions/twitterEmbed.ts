import { loadTwitterWidgets } from "#utils/twitterWidgets.ts";
import { HostElement } from "./CanvasElementBase.ts";

// Renders an X/Twitter tweet embedded on the canvas. The server hands us the
// script-free oEmbed blockquote (see `url-metadata.ts`); we inject it and let
// Twitter's widgets.js hydrate it into the live embed. If the script is blocked
// or fails, the blockquote itself is a readable fallback with a link out.
//
// The hydrated tweet has a deterministic natural height (tweet + media at the
// current width), which we measure and report via an `embed-resize` event so
// the canvas grows the shape to fit instead of clipping it.
//
// Was `CanvasTwitterEmbed.vue`; converted to a custom element so Canvas.vue is
// the only Vue component in the canvas tree.
class CanvasTwitterEmbedElement extends HostElement {
  private container: HTMLDivElement | null = null;
  private observer: ResizeObserver | null = null;
  private html = "";

  set value(html: string) {
    if (html === this.html) return;
    this.html = html;
    if (this.container) this.rerender();
  }
  get value() {
    return this.html;
  }

  connectedCallback() {
    this.style.display = "contents";
    if (!this.container) {
      const container = document.createElement("div");
      container.className = "canvas-twitter-embed";
      this.appendChild(container);
      this.container = container;
    }
    this.rerender();
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.observer = null;
  }

  private rerender() {
    if (!this.container) return;
    // oEmbed markup comes from Twitter's publish API and is fetched
    // script-free, so it is safe to inject.
    this.container.innerHTML = this.html;
    this.observer?.disconnect();
    void this.hydrate();
  }

  private reportHeight() {
    const el = this.container;
    if (!el) return;
    // scrollHeight reflects the full rendered tweet even while the container is
    // still clipped by the shape's current (smaller) height.
    const height = Math.ceil(el.scrollHeight);
    if (height > 0) {
      this.dispatchEvent(
        new CustomEvent("embed-resize", {
          detail: height,
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private async hydrate() {
    const el = this.container;
    if (!el) return;
    try {
      const twttr = await loadTwitterWidgets();
      await twttr.widgets.load(el);
      // widgets.js resizes the iframe as the tweet (and its media) load; track
      // it so the shape keeps fitting.
      const frame = el.querySelector("iframe");
      if (frame && typeof ResizeObserver !== "undefined") {
        if (!this.observer) this.observer = new ResizeObserver(() => this.reportHeight());
        this.observer.observe(frame);
      }
    } catch {
      // Leave the raw blockquote in place as a graceful fallback.
    }
    this.reportHeight();
  }
}

if (
  typeof customElements !== "undefined" &&
  !customElements.get("canvas-twitter-embed")
) {
  customElements.define("canvas-twitter-embed", CanvasTwitterEmbedElement);
}
