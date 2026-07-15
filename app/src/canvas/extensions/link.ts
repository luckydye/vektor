import { ref } from "vue";
import { api } from "#api/client.ts";
import type { LinkMetadata } from "#api/routes/v1/url-metadata.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "./CanvasElementBase.ts";
import "./twitterEmbed.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

function linkSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : "";
}

export const linkElement: CanvasElementExtension = {
  type: "link",
  defaults: {
    size: { width: 320, height: 200 },
    minSize: { width: 200, height: 80 },
    style: { color: "var(--canvas-link-bg, #ffffff)" },
    data: { text: "" },
  },
  isValid: (shape) => Boolean(linkSource(shape)),
  render: { surface: "dom", tag: "canvas-link" },
  behavior: {
    transform: { move: true, resize: "none", rotate: false },
    measurement: {
      normalize: (shape, size) => {
        if (
          size.height === undefined ||
          !Number.isFinite(size.height) ||
          size.height <= 0
        )
          return null;
        const src = linkSource(shape);
        const preview = src ? linkPreviews.previews.value.get(src) : undefined;
        if (!preview || preview.status === "loading") return null;
        const height = Math.max(
          linkElement.defaults.minSize.height,
          Math.round(size.height),
        );
        return Math.abs(height - shape.frame.height) <= 2 ? null : { height };
      },
    },
  },
  events: { data: (shape) => linkPreviewForShape(shape) ?? null },
  input: {
    paste: {
      priority: 50,
      handle: (event, context) => {
        const url = context.data?.getData("text/plain").trim() ?? "";
        if (!/^https?:\/\//i.test(url)) return false;
        try {
          new URL(url);
        } catch {
          return false;
        }
        event.preventDefault();
        context.command("insert-link", { url, at: context.at() });
        return true;
      },
    },
  },
};

export function createLinkShape(url: string, at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "link",
    frame: {
      x: Math.round(at.x - linkElement.defaults.size.width / 2),
      y: Math.round(at.y - linkElement.defaults.size.height / 2),
      width: linkElement.defaults.size.width,
      height: linkElement.defaults.size.height,
      rotation: 0,
    },
    style: { ...linkElement.defaults.style },
    data: { ...linkElement.defaults.data, src: url },
    updatedAt: Date.now(),
  };
}

export type LinkPreviewState = {
  status: "loading" | "loaded" | "error";
  metadata: LinkMetadata | null;
};

// True for links whose preview resolved to a Twitter/X embed. Those render the
// live <canvas-twitter-embed> instead of the generic card.
function isTwitterLinkPreview(preview: LinkPreviewState | null | undefined): boolean {
  return preview?.metadata?.embed?.provider === "twitter";
}

function hideOnError(img: HTMLImageElement) {
  img.addEventListener("error", () => {
    img.style.display = "none";
  });
}

// Renders a pasted link as either a Twitter/X embed (when its preview resolves
// to one) or a generic preview card. Both modes are owned here so the host
// stays type-agnostic; the mode is rebuilt only when it changes so the tweet
// isn't re-hydrated on every update.
class CanvasLinkElement extends CanvasElementBase {
  private mode: "card" | "twitter" | null = null;
  private anchor: HTMLAnchorElement | null = null;
  private embed: (HTMLElement & { value: string }) | null = null;
  private sizeObserver: ResizeObserver | null = null;
  private renderedSrc: string | null = null;
  private renderedPreview: LinkPreviewState | null | undefined = null;

  protected mount() {
    // Built lazily by update() once the preview determines the render mode.
  }

  protected update() {
    const shape = this.shapeData;
    if (!shape) return;
    const src = linkSource(shape);
    const preview = this.extra as LinkPreviewState | null | undefined;

    // Canvas mutations recreate the reactive shape objects, including this one
    // when only another shape changed. Keep the preview DOM intact unless one
    // of its actual inputs changed; rebuilding it reloads media and embeds.
    if (src === this.renderedSrc && preview === this.renderedPreview) return;
    this.renderedSrc = src;
    this.renderedPreview = preview;

    // Load our own preview; the reactive store drives the re-render via `data`.
    if (src) void loadLinkPreview(src);

    const mode: "card" | "twitter" =
      src && isTwitterLinkPreview(preview) ? "twitter" : "card";
    if (mode !== this.mode) this.buildMode(mode);

    if (this.mode === "twitter") {
      const html = preview?.metadata?.embed?.html;
      if (this.embed && html) this.embed.value = html;
      return;
    }

    const anchor = this.anchor;
    if (!anchor) return;
    anchor.href = src;
    const metadata = preview?.metadata ?? null;
    anchor.replaceChildren(this.buildImage(metadata), this.buildBody(shape, metadata));
    this.fitToContent();
  }

  private buildMode(mode: "card" | "twitter") {
    this.mode = mode;
    this.sizeObserver?.disconnect();
    this.sizeObserver = null;
    this.anchor = null;
    this.embed = null;
    this.replaceChildren();
    if (mode === "twitter") this.buildTwitter();
    else this.buildCard();
  }

  // Generic card: optional media, then site/title/description. An <a> so a plain
  // click navigates; a click that ended a drag is suppressed via wasDragged.
  private buildCard() {
    const anchor = document.createElement("a");
    anchor.className = "canvas-shape-link";
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.draggable = false;
    dragOnPointerDown(anchor, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    anchor.addEventListener(
      "click",
      (event) => {
        if (this.services?.wasDragged()) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
    this.appendChild(anchor);
    this.anchor = anchor;

    // Cards fit their height to the preview content (image keeps a 4/3 ratio, so
    // content height depends on card width). Observe the card box for width-
    // driven reflow; update() also re-measures when preview data arrives.
    if (typeof ResizeObserver !== "undefined") {
      this.sizeObserver = new ResizeObserver(() => this.fitToContent());
      this.sizeObserver.observe(anchor);
    }
  }

  // Live tweet embed. The embed reports its natural height via `embed-resize`,
  // which we forward to the host's height-fit so the shape grows to fit.
  private buildTwitter() {
    const wrap = document.createElement("div");
    wrap.className = "canvas-twitter-shape";
    dragOnPointerDown(wrap, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    wrap.addEventListener("wheel", (event) => event.stopPropagation());
    wrap.addEventListener("embed-resize", (event) => {
      const id = this.shapeData?.id;
      if (id) this.services?.reportSize(id, { height: (event as CustomEvent).detail });
    });
    const embed = document.createElement("canvas-twitter-embed") as HTMLElement & {
      value: string;
    };
    wrap.appendChild(embed);
    this.appendChild(wrap);
    this.embed = embed;
  }

  // Sum of the card's stacked children — the true content height, independent of
  // the (possibly clipping) shape box, so the shape can shrink as well as grow.
  private fitToContent() {
    const id = this.shapeData?.id;
    const anchor = this.anchor;
    if (!id || !anchor) return;
    let total = 0;
    for (const child of Array.from(anchor.children)) {
      total += (child as HTMLElement).offsetHeight;
    }
    const hostStyle = this.parentElement ? getComputedStyle(this.parentElement) : null;
    const borderHeight = hostStyle
      ? (Number.parseFloat(hostStyle.borderTopWidth) || 0) +
        (Number.parseFloat(hostStyle.borderBottomWidth) || 0)
      : 0;
    this.services?.reportSize(id, { height: Math.ceil(total + borderHeight) });
  }

  private buildImage(metadata: LinkMetadata | null): DocumentFragment {
    const fragment = document.createDocumentFragment();
    if (!metadata?.video && !metadata?.image) return fragment;

    const wrap = document.createElement("div");
    wrap.className = "canvas-link-image";
    if (metadata.video) {
      const video = document.createElement("video");
      video.src = `/api/v1/proxy-media?url=${encodeURIComponent(metadata.video)}`;
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.draggable = false;
      wrap.appendChild(video);
    } else if (metadata.image) {
      const img = document.createElement("img");
      img.src = metadata.image;
      img.alt = "";
      img.draggable = false;
      hideOnError(img);
      wrap.appendChild(img);
    }
    fragment.appendChild(wrap);
    return fragment;
  }

  private buildBody(shape: CanvasShape, metadata: LinkMetadata | null): HTMLElement {
    const body = document.createElement("div");
    body.className = "canvas-link-body";

    const site = document.createElement("div");
    site.className = "canvas-link-site";
    if (metadata?.favicon) {
      const favicon = document.createElement("img");
      favicon.src = metadata.favicon;
      favicon.className = "canvas-link-favicon";
      favicon.setAttribute("aria-hidden", "true");
      favicon.draggable = false;
      hideOnError(favicon);
      site.appendChild(favicon);
    }
    const domain = document.createElement("span");
    domain.className = "canvas-link-domain";
    domain.textContent =
      metadata?.siteName || (linkSource(shape) ? domainFromUrl(linkSource(shape)) : "");
    site.appendChild(domain);

    const title = document.createElement("div");
    title.className = "canvas-link-title";
    title.textContent = metadata?.title || linkSource(shape);

    body.append(site, title);

    if (metadata?.description) {
      const desc = document.createElement("div");
      desc.className = "canvas-link-desc";
      desc.textContent = metadata.description;
      body.appendChild(desc);
    }
    return body;
  }
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-link")) {
  customElements.define("canvas-link", CanvasLinkElement);
}

// Link preview cache. This is extension-owned module state (link previews are
// content-addressed by URL, and the only dependency is the api client), so the
// canvas host neither creates nor owns it — the link element loads its own
// preview and resolveData reads from here.
const previews = ref(new Map<string, LinkPreviewState>());

function setPreview(url: string, state: LinkPreviewState) {
  const next = new Map(previews.value);
  next.set(url, state);
  previews.value = next;
}

async function loadLinkPreview(url: string) {
  const existing = previews.value.get(url);
  // Error states are cached too. Retrying from every reactive canvas update
  // creates an unbounded request loop for URLs the endpoint cannot resolve.
  if (existing) return;
  setPreview(url, { status: "loading", metadata: null });
  try {
    setPreview(url, { status: "loaded", metadata: await api.linkPreview.get(url) });
  } catch {
    setPreview(url, { status: "error", metadata: null });
  }
}

function linkPreviewForShape(shape: CanvasShape): LinkPreviewState | undefined {
  const src = linkSource(shape);
  return src ? previews.value.get(src) : undefined;
}

// Reactive preview state used by this extension's data and measurement hooks.
export const linkPreviews = {
  previews,
  loadPreview: loadLinkPreview,
  previewForShape: linkPreviewForShape,
};
