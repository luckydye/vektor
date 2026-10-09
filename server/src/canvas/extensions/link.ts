import { api } from "#api/client.ts";
import type { LinkMetadata } from "#api/routes/url-metadata.ts";
import { shapePlacement, shapeQuad } from "#canvas/extensions/shapePaint.ts";
import { loadedImage } from "#canvas/render/images.ts";
import { drawImage, drawRoundedRect } from "#canvas/render/primitives.ts";
import { type RichTextTheme, richTextLayout } from "#canvas/render/richText.ts";
import { drawTextLayout, lineLayout } from "#canvas/render/text.ts";
import type { TextLayout } from "#canvas/render/textLayout.ts";
import { containQuad, drawVideo } from "#canvas/render/video.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import type { CanvasPaintHelpers, CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { shared } from "#canvas/runtime/state.ts";

function linkSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : "";
}

export const CanvasLink = CanvasElement.create({
  name: "link",

  addOptions() {
    return {
      size: { width: 320, height: 200 },
      minSize: { width: 200, height: 80 },
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "var(--canvas-link-bg, #ffffff)" },
      data: { text: "" },
    };
  },

  isValid: (shape) => Boolean(linkSource(shape)),

  addRender() {
    return { paint: paintLink, cursor: () => "move" };
  },

  addBehavior() {
    const { minSize } = this.options;
    return {
      transform: { move: true, resize: "none" as const, rotate: false },
      measurement: {
        // The card sizes itself to whatever the preview turns out to be, so the
        // measured height is accepted only once the preview has resolved.
        normalize: (shape: CanvasShape, size: { height?: number }) => {
          if (
            size.height === undefined ||
            !Number.isFinite(size.height) ||
            size.height <= 0
          )
            return null;
          const src = linkSource(shape);
          const preview = src ? linkPreviews.previews.get().get(src) : undefined;
          if (!preview || preview.status === "loading") return null;
          const height = Math.max(minSize.height, Math.round(size.height));
          return Math.abs(height - shape.frame.height) <= 2 ? null : { height };
        },
      },
    };
  },

  // A click that did not drag opens the link.
  addEvents() {
    return {
      click: (shape: CanvasShape, host: { openUrl: (url: string) => void }) => {
        const src = linkSource(shape);
        if (src) host.openUrl(src);
      },
    };
  },

  addInput() {
    return {
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
    };
  },
});

export function createLinkShape(url: string, at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "link",
    frame: {
      x: Math.round(at.x - CanvasLink.defaults.size.width / 2),
      y: Math.round(at.y - CanvasLink.defaults.size.height / 2),
      width: CanvasLink.defaults.size.width,
      height: CanvasLink.defaults.size.height,
      rotation: 0,
    },
    style: { ...CanvasLink.defaults.style },
    data: { ...CanvasLink.defaults.data, src: url },
    updatedAt: Date.now(),
  };
}

type LinkPreviewState = {
  status: "loading" | "loaded" | "error";
  metadata: LinkMetadata | null;
};

// Card geometry from `.canvas-link-*` in canvas.css.
const PADDING_X = 12;
const PADDING_Y = 10;
const GAP = 4;

// Stored links predate URL validation, so a malformed one shows as typed.
function domainFromUrl(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname : url;
}

// The tweet text and its "— Name (@handle) date" byline, from the oEmbed
// blockquote; the card draws them natively instead of loading widgets.js.
function tweetParts(html: string) {
  const quote = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("blockquote");
  if (!quote) throw new Error("Twitter embed has no blockquote");
  const text = quote.querySelector("p");
  const byline = [...quote.childNodes]
    .filter((node) => node !== text)
    .map((node) => node.textContent ?? "")
    .join("")
    .replace(/^\s*[—-]\s*/, "")
    .trim();
  return { html: text?.outerHTML ?? "", byline };
}

function cardTheme(
  helpers: CanvasPaintHelpers,
  size: number,
  color: string,
): RichTextTheme {
  return {
    size,
    lineHeight: 1.4,
    color,
    headings: [size, size, size, size, size, size],
    headingLineHeight: 1.3,
    headingColor: color,
    headingFace: "semibold",
    blockMargin: 0,
    headingMargin: { top: 0, bottom: 0 },
    listIndent: 16,
    itemMargin: 0,
    link: helpers.color("--canvas-doc-accent"),
    muted: helpers.color("--canvas-link-desc"),
    codeBackground: helpers.color("--canvas-handle-bg"),
    divider: helpers.color("--canvas-link-border"),
    accent: helpers.color("--canvas-doc-accent"),
  };
}

function paintLink(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const src = linkSource(shape);
  if (src) void loadLinkPreview(src);
  const preview = linkPreviewForShape(shape);
  const metadata = preview?.metadata ?? null;
  const { width, height } = shape.frame;
  const card = shapeQuad(shape, helpers, 0, 0, width, height);
  drawRoundedRect(gpu, card, {
    radius: 8 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-link-bg")),
    stroke: parseColor(helpers.color("--canvas-shape-border")),
    strokeWidth: helpers.scale,
  });
  const inner = width - 2;
  const textWidth = inner - PADDING_X * 2;
  const clip = { x: 0, y: 0, width: textWidth, height: height - 2 };
  let y = 1;

  const embed = metadata?.embed?.provider === "twitter" ? metadata.embed.html : null;
  const domain = metadata?.siteName || (src ? domainFromUrl(src) : "");
  const muted = helpers.color("--canvas-link-domain");
  const site = lineLayout(
    embed ? "x.com" : domain,
    {
      face: "regular",
      size: 11,
      color: muted,
    },
    helpers.invalidate,
  );
  let body: TextLayout | null;
  let byline: TextLayout | null = null;
  if (embed) {
    const tweet = tweetParts(embed);
    body = richTextLayout(
      tweet.html,
      cardTheme(helpers, 13, helpers.color("--canvas-link-title")),
      textWidth,
      helpers.invalidate,
    );
    byline = lineLayout(
      tweet.byline,
      { face: "semibold", size: 11, color: muted },
      helpers.invalidate,
    );
  } else {
    body = lineLayout(
      metadata?.title || src,
      {
        face: "semibold",
        size: 13,
        color: helpers.color("--canvas-link-title"),
      },
      helpers.invalidate,
      textWidth,
    );
  }
  const description =
    !embed && metadata?.description
      ? lineLayout(
          metadata.description,
          {
            face: "regular",
            size: 11,
            color: helpers.color("--canvas-link-desc"),
          },
          helpers.invalidate,
          textWidth,
        )
      : null;
  if (!site || !body) return;

  if (!embed && (metadata?.video || metadata?.image)) {
    const mediaHeight = (inner * 3) / 4;
    const frame = shapeQuad(shape, helpers, 1, 1, inner, mediaHeight);
    drawRoundedRect(gpu, frame, {
      radius: [7 * helpers.scale, 7 * helpers.scale, 0, 0],
      fill: parseColor(helpers.color("--canvas-handle-bg")),
    });
    if (metadata?.video) {
      drawVideo(gpu, metadata.video, frame, helpers.requestFrame);
    } else if (metadata?.image) {
      const loaded = loadedImage(metadata.image, helpers.invalidate);
      if (loaded) {
        drawImage(
          gpu,
          loaded,
          containQuad(frame, loaded.naturalWidth, loaded.naturalHeight),
        );
      }
    }
    y += mediaHeight;
  }

  y += PADDING_Y;
  let x = 1 + PADDING_X;
  const favicon =
    !embed && metadata?.favicon
      ? loadedImage(metadata.favicon, helpers.invalidate)
      : null;
  if (favicon) {
    drawImage(gpu, favicon, shapeQuad(shape, helpers, x, y, 14, 14));
    x += 20;
  }
  const place = (layout: TextLayout, left: number, top: number, maxHeight: number) => {
    drawTextLayout(
      gpu,
      layout,
      shapePlacement(
        shape,
        helpers,
        { x: left, y: top },
        {
          ...clip,
          width: textWidth - (left - 1 - PADDING_X),
          height: Math.min(maxHeight, height - 1 - top),
        },
      ),
    );
  };
  place(site, x, y, 14);
  y += Math.max(site.height, favicon ? 14 : 0) + GAP;

  // Title and description clamp to two lines, like `-webkit-line-clamp: 2`.
  const titleHeight = embed ? body.height : Math.min(body.height, 2 * 13 * 1.3);
  place(body, 1 + PADDING_X, y, titleHeight);
  y += titleHeight;
  if (byline) {
    y += GAP;
    place(byline, 1 + PADDING_X, y, byline.height);
    y += byline.height;
  }
  if (description) {
    y += GAP;
    const descHeight = Math.min(description.height, 2 * 11 * 1.4);
    place(description, 1 + PADDING_X, y, descHeight);
    y += descHeight;
  }
  y += PADDING_Y + 1;
  helpers.reportSize(shape.id, { height: Math.ceil(y) });
}

// Link preview cache. This is extension-owned module state (link previews are
// content-addressed by URL, and the only dependency is the api client), so the
// canvas host neither creates nor owns it — the link element loads its own
// preview and resolveData reads from here.
const previews = shared(new Map<string, LinkPreviewState>());

function setPreview(url: string, state: LinkPreviewState) {
  const next = new Map(previews.get());
  next.set(url, state);
  previews.set(next);
}

async function loadLinkPreview(url: string) {
  const existing = previews.get().get(url);
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
  return src ? previews.get().get(src) : undefined;
}

// Preview state used by this extension's painter and measurement hook. Writing
// a resolved preview repaints the canvases, so a card fills in when it lands.
const linkPreviews = {
  previews,
  loadPreview: loadLinkPreview,
  previewForShape: linkPreviewForShape,
};
