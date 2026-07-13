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

export const linkElement: CanvasElementExtension = {
  type: "link",
  defaultText: "",
  defaultColor: "var(--canvas-link-bg, #ffffff)",
  defaultSize: { width: 320, height: 200 },
  minSize: { width: 200, height: 80 },
  isValid: (shape) => Boolean(shape.src),
  surface: "dom",
  tag: "canvas-link",
  // Link cards fit their height to the preview content once it loads.
  transform: { move: true, resize: "none", rotate: false },
  resolveData: (shape) => linkPreviewForShape(shape) ?? null,
};

export function createLinkShape(url: string, at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "link",
    x: Math.round(at.x - linkElement.defaultSize.width / 2),
    y: Math.round(at.y - linkElement.defaultSize.height / 2),
    width: linkElement.defaultSize.width,
    height: linkElement.defaultSize.height,
    rotation: 0,
    text: "",
    color: linkElement.defaultColor,
    src: url,
    updatedAt: Date.now(),
  };
}

export type LinkPreviewState = {
  status: "loading" | "loaded" | "error";
  metadata: LinkMetadata | null;
};

// True for links whose preview resolved to a Twitter/X embed. Those keep the
// host-owned <CanvasTwitterEmbed> Vue component instead of the generic card, so
// the host renders them via the fallback branch.
export function isTwitterLinkPreview(preview: LinkPreviewState | undefined): boolean {
  return preview?.metadata?.embed?.provider === "twitter";
}

function hideOnError(img: HTMLImageElement) {
  img.addEventListener("error", () => {
    img.style.display = "none";
  });
}

// Generic link preview card: optional media, then site/title/description. Built
// as an <a> so a plain click navigates; a click that ended a drag is suppressed
// via hostContext.wasDragged. The card carries data-link-shape-id so the host's
// auto-size observer fits the shape height to the loaded content.
class CanvasLinkElement extends CanvasElementBase {
  private anchor: HTMLAnchorElement | null = null;
  private sizeObserver: ResizeObserver | null = null;

  protected mount() {
    const anchor = document.createElement("a");
    anchor.className = "canvas-shape-link";
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.draggable = false;
    if (this.shapeData) anchor.dataset.linkShapeId = this.shapeData.id;
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

    // Link cards fit their height to the preview content (image keeps a 4/3
    // ratio, so content height depends on card width). Observe the card box for
    // width-driven reflow; update() also re-measures when preview data arrives.
    if (typeof ResizeObserver !== "undefined") {
      this.sizeObserver = new ResizeObserver(() => this.fitToContent());
      this.sizeObserver.observe(anchor);
    }
  }

  protected update() {
    const shape = this.shapeData;
    const anchor = this.anchor;
    if (!shape || !anchor) return;
    if (shape.src) {
      anchor.href = shape.src;
      // Load our own preview; the reactive store drives the re-render via `data`.
      void loadLinkPreview(shape.src);
    }

    const metadata =
      (this.extra as LinkPreviewState | null | undefined)?.metadata ?? null;
    anchor.replaceChildren(this.buildImage(metadata), this.buildBody(shape, metadata));
    this.fitToContent();
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
    this.services?.fitHeight(id, total);
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
      metadata?.siteName ||
      (shape.src ? (this.services?.getDomainFromUrl(shape.src) ?? shape.src) : "");
    site.appendChild(domain);

    const title = document.createElement("div");
    title.className = "canvas-link-title";
    title.textContent = metadata?.title || shape.src || "";

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
  if (existing?.status === "loading" || existing?.status === "loaded") return;
  setPreview(url, { status: "loading", metadata: null });
  try {
    setPreview(url, { status: "loaded", metadata: await api.linkPreview.get(url) });
  } catch {
    setPreview(url, { status: "error", metadata: null });
  }
}

function linkPreviewForShape(shape: CanvasShape): LinkPreviewState | undefined {
  return shape.src ? previews.value.get(shape.src) : undefined;
}

// Reactive read surface for the host's link-card auto-size machinery (which
// measures card DOM and must not fit while a preview is still loading).
export const linkPreviews = {
  previews,
  loadPreview: loadLinkPreview,
  previewForShape: linkPreviewForShape,
};
