import type { DocumentWithProperties } from "#api/ApiClient.ts";
import type { LinkMetadata } from "#api/routes/url-metadata.ts";
import { shapePlacement, shapeQuad } from "#canvas/extensions/shapePaint.ts";
import { loadedImage } from "#canvas/render/images.ts";
import { remembered } from "#canvas/render/lru.ts";
import { drawImage, drawRoundedRect } from "#canvas/render/primitives.ts";
import { type RichTextTheme, richTextLayout } from "#canvas/render/richText.ts";
import { svgImage } from "#canvas/render/svgImage.ts";
import { drawTextLayout, lineLayout } from "#canvas/render/text.ts";
import type { TextLayout } from "#canvas/render/textLayout.ts";
import { containQuad } from "#canvas/render/video.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import type { CanvasPaintHelpers } from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { localPointInShape } from "#canvas/runtime/geometry.ts";
import { shared } from "#canvas/runtime/state.ts";
import { iconMarkup } from "#components/Icon.tsx";
import {
  createVektorDocumentAddress,
  type ParsedVektorDocumentAddress,
  parseVektorDocumentAddress,
  type VektorDocumentAddress,
} from "#documents/address.ts";
import {
  type DocumentPropertyValue,
  propertyValueToText,
} from "#documents/properties.ts";
import {
  type DocumentPreviewStatus,
  documentBodyHtml,
  documentTypeLabel,
  fetchWorkflowPreview,
  type WorkflowPreviewState,
} from "#editor/elements/document-attachment.ts";
import { sanitizeVektorDocumentPreviewHtml } from "#utils/html.ts";
import "#canvas/extensions/documentEditor.ts";
import type { CanvasExtensionHost, CanvasShape } from "#canvas/runtime/extensionApi.ts";

export const DOCUMENT_LINK_MIME = "application/x-vektor-document-link";

function shapeDocumentAddress(shape: CanvasShape) {
  return typeof shape.data.docAddress === "string" ? shape.data.docAddress : undefined;
}

function shapeSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : undefined;
}

function shapeText(shape: CanvasShape) {
  return typeof shape.data.text === "string" ? shape.data.text : "";
}

export type DocumentLinkReference = {
  address: VektorDocumentAddress;
};

async function resolveDocumentReferenceFromUrl(
  rawUrl: string,
  options: {
    currentOrigin: string;
    defaultSpaceId: string;
    spaces: ReadonlyArray<{ id: string; slug?: string | null }> | undefined;
    loadSpaces: () => Promise<ReadonlyArray<{ id: string; slug?: string | null }>>;
  },
): Promise<DocumentLinkReference | null> {
  const parts = documentUrlPartsFromUrl(rawUrl, {
    currentOrigin: options.currentOrigin,
    defaultSpaceId: options.defaultSpaceId,
  });
  if (!parts) return null;
  if (parts.spaceId) {
    return {
      address: createVektorDocumentAddress({
        origin: new URL(parts.url).origin,
        spaceId: parts.spaceId,
        documentId: parts.documentId,
        href: parts.url,
      }),
    };
  }
  if (isRemoteDocumentUrl(parts.url, options.currentOrigin)) return null;
  const spaces = options.spaces ?? (await options.loadSpaces());
  const space = spaces.find((entry) => entry.slug === parts.spaceSlug);
  if (!space) return null;
  return {
    address: createVektorDocumentAddress({
      origin: options.currentOrigin,
      spaceId: space.id,
      documentId: parts.documentId,
      href: parts.url,
    }),
  };
}

async function insertDocumentReference(
  ref: DocumentLinkReference,
  at: { x: number; y: number },
  options: {
    fetchDocument: (
      ref: ParsedVektorDocumentAddress,
    ) => Promise<LoadedDocumentPreviewSource>;
    insertDocument: (
      ref: DocumentLinkReference,
      at: { x: number; y: number },
      source: Pick<LoadedDocumentPreviewSource, "properties">,
    ) => void;
    fallbackToLink?: (url: string, at: { x: number; y: number }) => void;
    reportError: (error: unknown) => void;
  },
) {
  try {
    const parsed = parseVektorDocumentAddress(ref.address);
    if (!parsed) throw new Error("Invalid document address");
    const document = await options.fetchDocument(parsed);
    options.insertDocument(
      {
        address: createVektorDocumentAddress({
          origin: parsed.origin,
          spaceId: parsed.spaceId,
          documentId: document.id,
          href: parsed.href,
        }),
      },
      at,
      document,
    );
  } catch (error) {
    const href = parseVektorDocumentAddress(ref.address)?.href;
    if (href && options.fallbackToLink) options.fallbackToLink(href, at);
    else options.reportError(error);
  }
}

export async function insertDocumentUrl(
  url: string,
  at: { x: number; y: number },
  options: {
    currentOrigin: string;
    defaultSpaceId: string;
    spaces: ReadonlyArray<{ id: string; slug?: string | null }> | undefined;
    loadSpaces: () => Promise<ReadonlyArray<{ id: string; slug?: string | null }>>;
    fetchDocument: (
      ref: ParsedVektorDocumentAddress,
    ) => Promise<LoadedDocumentPreviewSource>;
    fetchMetadata: (url: string) => Promise<LinkMetadata | null>;
    insertDocument: (
      ref: DocumentLinkReference,
      at: { x: number; y: number },
      source: Pick<LoadedDocumentPreviewSource, "properties">,
    ) => void;
    insertLink: (url: string, at: { x: number; y: number }) => void;
    reportError: (error: unknown) => void;
  },
) {
  const ref = await resolveDocumentReferenceFromUrl(url, options);
  if (ref) {
    await insertDocumentReference(ref, at, {
      fetchDocument: options.fetchDocument,
      insertDocument: options.insertDocument,
      fallbackToLink: options.insertLink,
      reportError: options.reportError,
    });
    return;
  }

  const metadata = await options.fetchMetadata(url);
  const remote = metadata?.vektorDocument;
  if (!metadata || !remote) {
    options.insertLink(url, at);
    return;
  }
  options.insertDocument(
    {
      address:
        remote.address ??
        createVektorDocumentAddress({
          origin: new URL(metadata.url || url).origin,
          spaceId: remote.spaceId,
          documentId: remote.documentId,
          href: metadata.url || url,
        }),
    },
    at,
    { properties: { title: metadata.title ?? remote.documentSlug } },
  );
}

type DocumentPreviewState = {
  status: "loading" | "loaded" | "error";
  title: string;
  headerImage?: string;
  type?: string | null;
  content: string;
  readonly?: boolean;
  error?: string;
};

export type DocumentPreviewSource = Pick<
  DocumentWithProperties,
  "id" | "properties" | "type"
>;

type LoadedDocumentPreviewSource = DocumentPreviewSource & {
  content?: unknown;
  readonly?: boolean;
};

type DocumentLinkControllerOptions = {
  documents: () => DocumentPreviewSource[];
  currentOrigin: string;
  currentSpaceId: string;
  fetchDocument: (
    ref: ParsedVektorDocumentAddress,
  ) => Promise<LoadedDocumentPreviewSource>;
  insertShape: (shape: CanvasShape) => void;
  selectShape: (shapeId: string) => void;
  afterInsert?: () => void;
};

// Reactive view model resolved from the document-link preview controller and
// handed to <canvas-document> via its `data` property.

export const DOCUMENT_CANVAS_SERVICE = Symbol("canvas-document-service");

export type DocumentCanvasService = ReturnType<typeof createDocumentLinkController> & {
  canEdit: () => boolean;
  isRemote: (shape: CanvasShape) => boolean;
  address: (shape: CanvasShape) => string | undefined;
};

function documentService(host: CanvasExtensionHost) {
  return host.service<DocumentCanvasService>(DOCUMENT_CANVAS_SERVICE);
}

// Card geometry from `<document-attachment>`: a 1px border, a header with
// 10/12px padding, an optional 16:9 header image, and a body padded 12/14/16.
const HEADER = 52;
const BODY_PADDING = { top: 12, x: 14, bottom: 16 };
const OPEN_BUTTON = 24;

// Icon markup is parsed from source on every call; paints reuse one copy.
let documentIcon: string | null = null;
let openIcon: string | null = null;
const DOCUMENT_ICON = () => (documentIcon ??= iconMarkup("document"));
const OPEN_ICON = () => (openIcon ??= iconMarkup("chevron-right-thin"));

const workflowPreviews = new Map<string, WorkflowPreviewState>();

function workflowPreview(spaceId: string, documentId: string, invalidate: () => void) {
  const key = `${spaceId}:${documentId}`;
  const cached = workflowPreviews.get(key);
  if (cached) return cached;
  workflowPreviews.set(key, { status: "loading" });
  fetchWorkflowPreview(spaceId, documentId)
    .catch(
      (error): WorkflowPreviewState => ({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to load latest workflow run.",
      }),
    )
    .then((preview) => {
      workflowPreviews.set(key, preview);
      invalidate();
    });
  return workflowPreviews.get(key) ?? null;
}

function bodyTheme(helpers: Pick<CanvasPaintHelpers, "color">): RichTextTheme {
  const muted = helpers.color("--canvas-muted");
  return {
    size: 13,
    lineHeight: 1.45,
    color: helpers.color("--canvas-doc-content"),
    headings: [22, 18, 15, 13, 13, 13],
    headingLineHeight: 1.18,
    headingColor: helpers.color("--canvas-text"),
    headingFace: "bold",
    blockMargin: 0.55,
    headingMargin: { top: 0.8, bottom: 0.35 },
    listIndent: 16,
    itemMargin: 0,
    link: helpers.color("--canvas-doc-accent"),
    muted,
    codeBackground: helpers.color("--canvas-tool-hover-bg"),
    divider: helpers.color("--canvas-doc-divider"),
    accent: helpers.color("--canvas-doc-accent"),
    classes: {
      empty: { color: muted },
      "workflow-meta": { color: muted, size: 11 },
      "workflow-status": { face: "bold", size: 11 },
      completed: { highlight: "#dcfce7", color: "#047857" },
      failed: { highlight: "#fee2e2", color: "#b91c1c" },
      running: { highlight: "#dbeafe", color: "#1d4ed8" },
      neutral: { highlight: "#f3f4f6", color: "#4b5563" },
    },
  };
}

interface DocumentCardGeometry {
  bodyTop: number;
  bodyHeight: number;
  contentWidth: number;
  layout: TextLayout | null;
}

function cardGeometry(
  shape: CanvasShape,
  host: CanvasExtensionHost,
  helpers: Pick<CanvasPaintHelpers, "color" | "invalidate">,
): DocumentCardGeometry {
  const documents = documentService(host);
  const { width, height } = shape.frame;
  const imageHeight = documents.shapeHeaderImage(shape) ? ((width - 2) * 9) / 16 + 1 : 0;
  const bodyTop = 1 + HEADER + imageHeight;
  const contentWidth = width - 2 - BODY_PADDING.x * 2;
  const type = documents.shapeType(shape);
  const spaceId = documents.documentSpaceIdForShape(shape) || host.spaceId;
  const documentId = documents.isRemote(shape)
    ? ""
    : documents.documentIdForShape(shape) || "";
  const html = cachedBodyHtml({
    status: documents.shapeStatus(shape) as DocumentPreviewStatus,
    type,
    content: documents.shapeContent(shape),
    workflow:
      type === "workflow"
        ? spaceId && documentId
          ? workflowPreview(spaceId, documentId, helpers.invalidate)
          : { status: "error", message: "Missing workflow id." }
        : null,
  });
  return {
    bodyTop,
    bodyHeight: height - 1 - bodyTop,
    contentWidth,
    layout: richTextLayout(html, bodyTheme(helpers), contentWidth, helpers.invalidate),
  };
}

function paintDocument(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const documents = documentService(helpers.host);
  const { width, height } = shape.frame;
  const pixels = helpers.scale * helpers.dpr;
  const divider = parseColor(helpers.color("--canvas-doc-divider"));
  drawRoundedRect(gpu, shapeQuad(shape, helpers, 0, 0, width, height), {
    radius: 8 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-doc-bg")),
    stroke: parseColor(helpers.color("--canvas-shape-border")),
    strokeWidth: helpers.scale,
  });

  const icon = svgImage(
    DOCUMENT_ICON(),
    helpers.color("--canvas-doc-accent"),
    18 * pixels,
    helpers.invalidate,
  );
  if (icon)
    drawImage(gpu, icon, shapeQuad(shape, helpers, 13, 1 + HEADER / 2 - 9, 18, 18));
  const textLeft = 13 + 18 + 10;
  const textWidth = width - textLeft - 12 - OPEN_BUTTON - 10;
  const title = lineLayout(
    documents.shapeTitle(shape),
    { face: "bold", size: 14, color: helpers.color("--canvas-text") },
    helpers.invalidate,
  );
  const typeLabel = lineLayout(
    documentTypeLabel(documents.shapeType(shape)),
    { face: "regular", size: 11, color: helpers.color("--canvas-muted") },
    helpers.invalidate,
  );
  if (title && typeLabel) {
    const top = 1 + (HEADER - title.height - 2 - typeLabel.height) / 2;
    const clip = (layout: TextLayout) => ({
      x: 0,
      y: 0,
      width: textWidth,
      height: layout.height,
    });
    drawTextLayout(
      gpu,
      title,
      shapePlacement(shape, helpers, { x: textLeft, y: top }, clip(title)),
    );
    drawTextLayout(
      gpu,
      typeLabel,
      shapePlacement(
        shape,
        helpers,
        { x: textLeft, y: top + title.height + 2 },
        clip(typeLabel),
      ),
    );
  }
  const chevron = svgImage(
    OPEN_ICON(),
    helpers.color("--canvas-muted"),
    16 * pixels,
    helpers.invalidate,
  );
  if (chevron) {
    const x = width - 1 - 12 - OPEN_BUTTON + 4;
    drawImage(gpu, chevron, shapeQuad(shape, helpers, x, 1 + HEADER / 2 - 8, 16, 16));
  }
  drawRoundedRect(gpu, shapeQuad(shape, helpers, 1, HEADER, width - 2, 1), {
    fill: divider,
  });

  const headerImage = documents.shapeHeaderImage(shape);
  if (headerImage) {
    const frame = shapeQuad(
      shape,
      helpers,
      1,
      1 + HEADER,
      width - 2,
      ((width - 2) * 9) / 16,
    );
    drawRoundedRect(gpu, frame, {
      fill: parseColor(helpers.color("--canvas-tool-hover-bg")),
    });
    const image = loadedImage(headerImage, helpers.invalidate);
    if (image) {
      drawImage(gpu, image, containQuad(frame, image.naturalWidth, image.naturalHeight));
    }
    drawRoundedRect(
      gpu,
      shapeQuad(shape, helpers, 1, 1 + HEADER + ((width - 2) * 9) / 16, width - 2, 1),
      { fill: divider },
    );
  }

  const geometry = cardGeometry(shape, helpers.host, helpers);
  if (!geometry.layout) return;
  drawTextLayout(
    gpu,
    geometry.layout,
    shapePlacement(
      shape,
      helpers,
      { x: 1 + BODY_PADDING.x, y: geometry.bodyTop + BODY_PADDING.top },
      {
        x: -BODY_PADDING.x,
        y: -BODY_PADDING.top,
        width: geometry.contentWidth + BODY_PADDING.x * 2,
        height: geometry.bodyHeight,
      },
    ),
    (src) => loadedImage(src, helpers.invalidate),
  );
}

// What a card-local point lands on in the body: a task checkbox, whose toggle
// is replayed in the editor the click mounts, or a link.
function bodyHit(
  shape: CanvasShape,
  host: CanvasExtensionHost,
  local: { x: number; y: number },
) {
  const geometry = cardGeometry(shape, host, geometryOnly);
  const layout = geometry.layout;
  if (!layout) return { task: null, href: null };
  const x = local.x - 1 - BODY_PADDING.x;
  const y = local.y - geometry.bodyTop - BODY_PADDING.top;
  const pad = 4;
  const task = layout.checkboxes.find(
    (box) =>
      x >= box.x - pad &&
      x <= box.x + box.size + pad &&
      y >= box.y - pad &&
      y <= box.y + box.size + pad,
  );
  const link = layout.links.find(
    (box) =>
      x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height,
  );
  return { task: task?.index ?? null, href: link?.href ?? null };
}

const bodyHtml = new Map<string, { status: string; type: string; html: string }>();

// Sanitizing a document's HTML is costly, so it runs once per content, not per
// paint. Workflow summaries are small and change with their run.
function cachedBodyHtml(params: Parameters<typeof documentBodyHtml>[0]): string {
  if (params.workflow) return documentBodyHtml(params);
  const type = params.type ?? "";
  const cached = remembered(bodyHtml, params.content, 1024, () => ({
    status: params.status,
    type,
    html: documentBodyHtml(params),
  }));
  if (cached.status === params.status && cached.type === type) return cached.html;
  const html = documentBodyHtml(params);
  bodyHtml.set(params.content, { status: params.status, type, html });
  return html;
}

// Hit tests only need the card's geometry, which colours do not change.
const geometryOnly = { color: () => "#000", invalidate: () => {} };

function openEditor(
  shape: CanvasShape,
  host: CanvasExtensionHost,
  toggleTaskIndex: number | null,
) {
  if (shape.locked) return;
  const documents = documentService(host);
  const documentId = documents.documentIdForShape(shape);
  const address = documents.address(shape);
  if (!documentId || !address) return;
  if (!documents.canEdit() || documents.isRemote(shape)) return;
  if (documents.documentSpaceIdForShape(shape) !== host.spaceId) return;
  if (!documents.inlineEditable(shape)) return;
  // The editor is a plain custom element, so its session is created here and
  // torn down in `finish` — there is no unmount hook to do it.
  const collaboration = host.createCollaboration?.({ spaceId: host.spaceId, documentId });
  host.beginEdit({
    shapeId: shape.id,
    tag: "canvas-document-editor",
    className: "canvas-shape-document-editor",
    props: {
      spaceId: host.spaceId,
      documentId,
      documentTitle: documents.shapeTitle(shape),
      headerImage: documents.shapeHeaderImage(shape),
      toggleTaskIndex,
      collaboration,
    },
    finish: (element) => {
      const editor = element as
        | (HTMLElement & { getHtml?: () => string | null; destroy?: () => void })
        | null;
      const html = editor?.getHtml?.();
      if (typeof html === "string") documents.setPreviewContent(address, html);
      editor?.destroy?.();
    },
  });
}

export const CanvasDocumentLink = CanvasElement.create({
  name: "document",

  addOptions() {
    return {
      size: { width: 380, height: 280 },
      minSize: { width: 280, height: 180 },
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "var(--canvas-doc-bg)" },
      data: { text: "Untitled" },
    };
  },

  isValid: (shape) => Boolean(parseVektorDocumentAddress(shapeDocumentAddress(shape))),
  addRender() {
    return {
      paint: paintDocument,
      hitTest: (shape: CanvasShape, world: { x: number; y: number }) => {
        const local = localPointInShape(shape.frame, world);
        const { width, height } = shape.frame;
        if (local.x < 0 || local.y < 0 || local.x > width || local.y > height)
          return null;
        const buttonLeft = width - 1 - 12 - OPEN_BUTTON;
        const buttonTop = 1 + (HEADER - OPEN_BUTTON) / 2;
        const onButton =
          local.x >= buttonLeft &&
          local.x <= buttonLeft + OPEN_BUTTON &&
          local.y >= buttonTop &&
          local.y <= buttonTop + OPEN_BUTTON;
        return onButton ? "open" : "body";
      },
      cursor: (_shape: CanvasShape, region: string) =>
        region === "open" ? "pointer" : "move",
    };
  },
  addBehavior() {
    return { transform: { move: true, resize: "box" as const, rotate: false } };
  },
  parseData: (data) => ({ ...data }),
  addEvents() {
    return {
      prepare: {
        key: (shape) => documentAddressForShape(shape) ?? null,
        run: (shape, host) => {
          const address = documentAddressForShape(shape);
          if (address) void documentService(host).loadPreview(address);
        },
      },
      // The open button navigates; a click anywhere else edits in place.
      click: (shape, host, hit) => {
        if (
          hit.event.shiftKey ||
          hit.event.ctrlKey ||
          hit.event.metaKey ||
          hit.event.altKey
        ) {
          return;
        }
        const href = documentService(host).documentHrefForShape(shape);
        if (hit.region === "open") {
          if (href) host.openUrl(href);
          return;
        }
        const body = bodyHit(shape, host, hit.local);
        if (href && body.href?.startsWith("document:")) {
          host.openUrl(siblingDocumentHref(href, body.href.slice("document:".length)));
          return;
        }
        openEditor(shape, host, body.task);
      },
    };
  },

  addInput() {
    return {
      paste: {
        priority: 70,
        handle: (event, context) => {
          const url = context.data?.getData("text/plain").trim() ?? "";
          if (
            (!/^https?:\/\//i.test(url) && !url.startsWith("/")) ||
            context.command("is-document-url", url) !== true
          )
            return false;
          event.preventDefault();
          context.command("insert-document-url", { url, at: context.at() });
          return true;
        },
      },
      drop: {
        priority: 90,
        handle: (event, context) => {
          if (context.phase === "preview") {
            if (!dragHasDocumentLink(context.data)) return false;
            event.preventDefault();
            if (context.data) context.data.dropEffect = "move";
            return true;
          }

          const reference = droppedDocumentReference(context.data);
          if (!reference) return false;
          event.preventDefault();
          if (context.data) context.data.dropEffect = "move";
          context.command("insert-document-ref", { reference, at: context.at() });
          return true;
        },
      },
    };
  },
});

function documentLabel(doc: {
  properties?: { title?: DocumentPropertyValue | null } | null;
}): string {
  const title = doc.properties?.title;
  const text = title ? propertyValueToText(title).trim() : "";
  return text || "Untitled";
}

function documentHeaderImage(doc: {
  properties?: { headerImage?: DocumentPropertyValue | null } | null;
}): string | undefined {
  const value = doc.properties?.headerImage;
  return Array.isArray(value) ? value[0] : value || undefined;
}

export function createDocumentLinkShape(
  ref: string | DocumentLinkReference,
  at: { x: number; y: number },
  doc?: Pick<DocumentWithProperties, "properties">,
): CanvasShape | null {
  const reference = normalizeDocumentReference(ref);
  const parsed = parseVektorDocumentAddress(reference?.address);
  if (!parsed) return null;

  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "document",
    frame: {
      x: Math.round(at.x - CanvasDocumentLink.defaults.size.width / 2),
      y: Math.round(at.y - CanvasDocumentLink.defaults.size.height / 2),
      width: CanvasDocumentLink.defaults.size.width,
      height: CanvasDocumentLink.defaults.size.height,
      rotation: 0,
    },
    style: { ...CanvasDocumentLink.defaults.style },
    data: {
      ...CanvasDocumentLink.defaults.data,
      text: doc ? documentLabel(doc) : CanvasDocumentLink.defaults.data.text,
      docAddress: parsed.address,
      src: parsed.href,
    },
    updatedAt: Date.now(),
  };
}

function initialDocumentPreview(
  documentId: string,
  docs: DocumentPreviewSource[],
): DocumentPreviewState {
  const doc = docs.find((entry) => entry.id === documentId);
  return {
    status: "loading",
    title: doc ? documentLabel(doc) : "Untitled",
    headerImage: doc ? documentHeaderImage(doc) : undefined,
    type: doc?.type,
    content: "",
  };
}

function documentIdForShape(shape: CanvasShape): string | undefined {
  return parseVektorDocumentAddress(shapeDocumentAddress(shape))?.documentId;
}

function documentSpaceIdForShape(
  shape: CanvasShape,
  fallbackSpaceId: string,
): string | undefined {
  return (
    parseVektorDocumentAddress(shapeDocumentAddress(shape))?.spaceId || fallbackSpaceId
  );
}

// Swaps the document segment of a document href, keeping origin and space path.
function siblingDocumentHref(href: string, documentId: string): string {
  try {
    const base = new URL(href, window.location.origin);
    return new URL(`./${encodeURIComponent(documentId)}`, base).toString();
  } catch {
    return href;
  }
}

function documentHrefForShape(shape: CanvasShape): string | undefined {
  return (
    parseVektorDocumentAddress(shapeDocumentAddress(shape))?.href ?? shapeSource(shape)
  );
}

export function documentAddressForShape(shape: CanvasShape): string | undefined {
  return parseVektorDocumentAddress(shapeDocumentAddress(shape))?.address;
}

// A document address (or bare URL) whose origin differs from this instance —
// its content lives on another Vektor deployment and is fetched cross-origin.
export function isRemoteDocumentAddress(
  address: string | undefined,
  currentOrigin: string,
): address is string {
  const origin = parseVektorDocumentAddress(address)?.origin;
  return Boolean(origin && origin !== currentOrigin);
}

export function isRemoteDocumentShape(
  shape: CanvasShape,
  currentOrigin: string,
): boolean {
  return (
    shape.type === "document" &&
    isRemoteDocumentAddress(documentAddressForShape(shape), currentOrigin)
  );
}

function isRemoteDocumentUrl(
  url: string | undefined,
  currentOrigin: string,
): url is string {
  if (!url) return false;
  try {
    return new URL(url, currentOrigin).origin !== currentOrigin;
  } catch {
    return false;
  }
}

// Fetches a document that lives on another Vektor origin, shaped like the
// controller's fetchDocument result (its preview HTML sanitized for embedding).
export async function fetchRemoteDocumentByAddress(
  ref: ParsedVektorDocumentAddress,
): Promise<LoadedDocumentPreviewSource> {
  const response = await fetch(
    `${ref.origin}/api/v1/spaces/${encodeURIComponent(ref.spaceId)}/documents/${encodeURIComponent(ref.documentId)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch remote document: ${response.status}`);
  }
  const data = (await response.json()) as { document?: unknown };
  const document = data.document as
    | {
        id?: unknown;
        slug?: unknown;
        properties?: unknown;
        type?: unknown;
        content?: unknown;
      }
    | undefined;
  if (!document || typeof document.id !== "string") {
    throw new Error("Invalid remote document response");
  }
  const properties =
    document.properties && typeof document.properties === "object"
      ? (document.properties as Record<string, string | string[]>)
      : {};
  return {
    id: document.id,
    properties,
    type: typeof document.type === "string" ? document.type : "document",
    content:
      typeof document.content === "string"
        ? sanitizeVektorDocumentPreviewHtml(document.content)
        : "",
  };
}

// Parses a Vektor document URL (…/doc/<id> or …/<space-slug>/doc/<id>) into its
// document id + space locator. Returns null for anything that isn't one.
export function documentUrlPartsFromUrl(
  rawUrl: string,
  context: { currentOrigin: string; defaultSpaceId: string },
): { documentId: string; spaceId?: string; spaceSlug?: string; url: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed, context.currentOrigin);
  } catch {
    return null;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) return null;

  let spaceId: string | undefined;
  let spaceSlug: string | undefined;
  let documentPath = "";

  if (pathParts[0] === "doc" && pathParts[1]) {
    spaceId = context.defaultSpaceId;
    documentPath = pathParts.slice(1).join("/");
  } else if (pathParts[1] === "doc" && pathParts[2]) {
    spaceSlug = pathParts[0];
    documentPath = pathParts.slice(2).join("/");
  }

  if ((!spaceId && !spaceSlug) || !documentPath) return null;
  let documentId: string;
  try {
    documentId = decodeURIComponent(documentPath);
  } catch {
    return null;
  }

  return {
    documentId,
    ...(spaceId ? { spaceId } : {}),
    ...(spaceSlug ? { spaceSlug } : {}),
    url: url.href,
  };
}

// Only plain rich-text documents can be edited inline on the canvas. Other
// types render specialized previews, and readonly documents reject writes
// server-side.
function previewSupportsInlineEditing(
  preview: DocumentPreviewState | undefined,
): boolean {
  if (preview?.status !== "loaded") return false;
  if (preview.readonly) return false;
  return (preview.type ?? "document") === "document";
}

function documentShapeTitle(shape: CanvasShape, preview?: DocumentPreviewState): string {
  return preview?.title || shapeText(shape) || "Untitled";
}

function normalizeDocumentReference(
  ref: string | DocumentLinkReference | null | undefined,
): DocumentLinkReference | null {
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    if (parseVektorDocumentAddress(trimmed)) return { address: trimmed };
    return null;
  }

  const address = ref?.address?.trim();
  if (address && parseVektorDocumentAddress(address)) return { address };
  return null;
}

export function documentReferenceKey(ref: DocumentLinkReference): string {
  return ref.address;
}

export function droppedDocumentReference(
  transfer: DataTransfer | null,
): DocumentLinkReference | null {
  if (!transfer) return null;

  const structured = transfer.getData(DOCUMENT_LINK_MIME).trim();
  if (!structured) return null;

  try {
    const parsed = JSON.parse(structured) as Partial<DocumentLinkReference>;
    const ref = normalizeDocumentReference({
      address: typeof parsed.address === "string" ? parsed.address : "",
    });
    if (ref) return ref;
  } catch {
    return null;
  }
  return null;
}

function dragHasDocumentLink(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types.includes(DOCUMENT_LINK_MIME));
}

export function createDocumentLinkController(options: DocumentLinkControllerOptions) {
  const previews = shared(new Map<string, DocumentPreviewState>());

  function setPreview(key: string, preview: DocumentPreviewState) {
    const next = new Map(previews.get());
    next.set(key, preview);
    previews.set(next);
  }

  function initialPreview(documentId: string): DocumentPreviewState {
    return initialDocumentPreview(documentId, options.documents());
  }

  function cachedPreview(shape: CanvasShape): DocumentPreviewState | undefined {
    const ref = referenceForShape(shape);
    return ref ? previews.get().get(documentReferenceKey(ref)) : undefined;
  }

  function referenceForShape(shape: CanvasShape): DocumentLinkReference | null {
    return normalizeDocumentReference(shapeDocumentAddress(shape));
  }

  async function loadPreview(refInput: string | DocumentLinkReference) {
    const ref = normalizeDocumentReference(refInput);
    if (!ref) return;

    const parsed = parseVektorDocumentAddress(ref.address);
    if (!parsed) return;

    const key = documentReferenceKey(ref);
    const existing = previews.get().get(key);
    if (existing?.status === "loading" || existing?.status === "loaded") return;

    setPreview(key, initialPreview(parsed.documentId));

    try {
      const doc = await options.fetchDocument(parsed);
      setPreview(key, {
        status: "loaded",
        title: initialDocumentPreview(parsed.documentId, [doc]).title,
        headerImage: documentHeaderImage(doc),
        type: doc.type,
        content: typeof doc.content === "string" ? doc.content : "",
        readonly: Boolean(doc.readonly),
      });
    } catch (error) {
      const fallback = previews.get().get(key) ?? initialPreview(parsed.documentId);
      setPreview(key, {
        ...fallback,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function shapeTitle(shape: CanvasShape): string {
    return documentShapeTitle(shape, cachedPreview(shape));
  }

  function shapeStatus(shape: CanvasShape): DocumentPreviewState["status"] {
    return cachedPreview(shape)?.status ?? "loading";
  }

  function shapeHeaderImage(shape: CanvasShape): string {
    return cachedPreview(shape)?.headerImage ?? "";
  }

  function shapeType(shape: CanvasShape): string {
    return cachedPreview(shape)?.type ?? "document";
  }

  function shapeContent(shape: CanvasShape): string {
    return cachedPreview(shape)?.content ?? "";
  }

  // Refresh the cached preview after an inline editing session so the
  // read-only card reflects what the editor last showed instead of the
  // content fetched before the edit.
  function setPreviewContent(refInput: string | DocumentLinkReference, content: string) {
    const ref = normalizeDocumentReference(refInput);
    if (!ref) return;
    const key = documentReferenceKey(ref);
    const existing = previews.get().get(key);
    if (existing?.status !== "loaded") return;
    setPreview(key, { ...existing, content });
  }

  // Places a card on the canvas that links to another document by address.
  function insertDocumentLink(
    refInput: string | DocumentLinkReference,
    at: { x: number; y: number },
    docOverride?: Pick<DocumentWithProperties, "properties">,
  ): boolean {
    const ref = normalizeDocumentReference(refInput);
    if (!ref) return false;
    const parsed = parseVektorDocumentAddress(ref.address);
    if (!parsed) return false;
    const doc =
      docOverride ?? options.documents().find((entry) => entry.id === parsed.documentId);
    const shape = createDocumentLinkShape(ref, at, doc);
    if (!shape) return false;

    options.insertShape(shape);
    options.selectShape(shape.id);
    const shapeRef = referenceForShape(shape);
    if (shapeRef) void loadPreview(shapeRef);
    options.afterInsert?.();
    return true;
  }

  return {
    previews,
    cachedPreview,
    initialPreview,
    loadPreview,
    documentIdForShape,
    documentHrefForShape,
    documentSpaceIdForShape: (shape: CanvasShape) =>
      documentSpaceIdForShape(shape, options.currentSpaceId),
    shapeTitle,
    shapeHeaderImage,
    shapeStatus,
    shapeType,
    shapeContent,
    // Only plain rich-text docs with a loaded preview can be edited inline.
    inlineEditable: (shape: CanvasShape) =>
      previewSupportsInlineEditing(cachedPreview(shape)),
    setPreviewContent,
    insertDocumentLink,
  };
}
