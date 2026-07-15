import { type Ref, ref } from "vue";
import "#editor/elements/document-attachment.ts";
import type { DocumentWithProperties } from "#api/ApiClient.ts";
import type { LinkMetadata } from "#api/routes/v1/url-metadata.ts";
import {
  createVektorDocumentAddress,
  type ParsedVektorDocumentAddress,
  parseVektorDocumentAddress,
  type VektorDocumentAddress,
} from "#utils/documentAddress.ts";
import { sanitizeVektorDocumentPreviewHtml } from "#utils/documentHtmlSanitizer.ts";
import {
  type DocumentPropertyValue,
  propertyValueToText,
} from "#utils/documentProperties.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "./CanvasElementBase.ts";
import "./documentEditor.ts";
import type {
  CanvasElementExtension,
  CanvasExtensionHost,
  CanvasShape,
} from "./types.ts";

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

export async function resolveDocumentReferenceFromUrl(
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

export async function insertDocumentReference(
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

export type DocumentPreviewState = {
  status: "loading" | "loaded" | "error";
  title: string;
  headerImage?: string;
  type?: string | null;
  content: string;
  readonly?: boolean;
  error?: string;
};

type DocumentPreviewSource = Pick<DocumentWithProperties, "id" | "properties" | "type">;

type LoadedDocumentPreviewSource = DocumentPreviewSource & {
  content?: unknown;
  readonly?: boolean;
};

export type DocumentLinkControllerOptions = {
  documents: Ref<DocumentPreviewSource[]>;
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
export type CanvasDocumentData = {
  title: string;
  headerImage: string;
  type: string;
  status: string;
  content: string;
  spaceId: string;
  documentId: string;
};

export const DOCUMENT_CANVAS_SERVICE = Symbol("canvas-document-service");

export type DocumentCanvasService = ReturnType<typeof createDocumentLinkController> & {
  canEdit: () => boolean;
  isRemote: (shape: CanvasShape) => boolean;
  address: (shape: CanvasShape) => string | undefined;
};

function documentService(host: CanvasExtensionHost) {
  return host.service<DocumentCanvasService>(DOCUMENT_CANVAS_SERVICE);
}

// Ordinal of the checkbox the click landed on within the read-only card, or
// null when the click wasn't on a task checkbox. Used to replay the toggle in
// the editor the click is about to mount. The preview renders checkboxes as
// non-interactive static HTML (the click actually lands on the card host), so
// we hit-test the click point against the checkbox rects rather than the path.
function clickedTaskCheckboxIndex(event: MouseEvent): number | null {
  const host = event.currentTarget as HTMLElement | null;
  const view = host?.shadowRoot?.querySelector("document-view") as HTMLElement | null;
  const root = view?.shadowRoot;
  if (!root) return null;
  const pad = 4;
  const index = Array.from(
    root.querySelectorAll<HTMLElement>('input[type="checkbox"]'),
  ).findIndex((checkbox) => {
    const rect = checkbox.getBoundingClientRect();
    return (
      event.clientX >= rect.left - pad &&
      event.clientX <= rect.right + pad &&
      event.clientY >= rect.top - pad &&
      event.clientY <= rect.bottom + pad
    );
  });
  return index >= 0 ? index : null;
}

export const documentLinkElement: CanvasElementExtension = {
  type: "document",
  defaults: {
    size: { width: 380, height: 280 },
    minSize: { width: 280, height: 180 },
    style: { color: "var(--canvas-doc-bg)" },
    data: { text: "Untitled" },
  },
  isValid: (shape) => Boolean(parseVektorDocumentAddress(shapeDocumentAddress(shape))),
  render: { surface: "dom", tag: "canvas-document" },
  behavior: { transform: { move: true, resize: "box", rotate: false } },
  storage: {
    parseData: (data) => ({ ...data }),
  },
  events: {
    prepare: {
      key: (shape) => documentAddressForShape(shape) ?? null,
      run: (shape, host) => {
        const address = documentAddressForShape(shape);
        if (address) void documentService(host).loadPreview(address);
      },
    },
    data: (shape, host): CanvasDocumentData => {
      const documents = documentService(host);
      return {
        title: documents.shapeTitle(shape),
        headerImage: documents.shapeHeaderImage(shape),
        type: documents.shapeType(shape),
        status: documents.shapeStatus(shape),
        content: documents.shapeContent(shape),
        spaceId: documents.documentSpaceIdForShape(shape) || host.spaceId,
        documentId: documents.isRemote(shape)
          ? ""
          : documents.documentIdForShape(shape) || "",
      };
    },
    activate: (shape, host, event) => {
      if (event.button !== 0) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (host.wasDragged() || shape.locked) return;
      const documents = documentService(host);
      const documentId = documents.documentIdForShape(shape);
      const address = documents.address(shape);
      if (!documentId || !address) return;
      if (!documents.canEdit() || documents.isRemote(shape)) return;
      if (documents.documentSpaceIdForShape(shape) !== host.spaceId) return;
      if (!documents.inlineEditable(shape)) return;
      host.beginEdit({
        shapeId: shape.id,
        tag: "canvas-document-editor",
        className: "canvas-shape-document-editor",
        props: {
          spaceId: host.spaceId,
          documentId,
          title: documents.shapeTitle(shape),
          headerImage: documents.shapeHeaderImage(shape),
          toggleTaskIndex: clickedTaskCheckboxIndex(event),
        },
        finish: (element) => {
          const html = (
            element as (HTMLElement & { getHtml?: () => string | null }) | null
          )?.getHtml?.();
          if (typeof html === "string") documents.setPreviewContent(address, html);
        },
      });
    },
    open: (shape, host, event) => {
      event.preventDefault();
      if (host.wasDragged()) return;
      const requested =
        event instanceof CustomEvent && typeof event.detail?.documentId === "string"
          ? event.detail.documentId
          : null;
      const documents = documentService(host);
      const documentId = requested ?? documents.documentIdForShape(shape);
      if (!documentId) return;
      const href = documents.documentHrefForShape(shape);
      if (documents.isRemote(shape) && href) {
        host.openUrl(href);
        return;
      }
      host.dispatch("view-document", {
        spaceId: documents.documentSpaceIdForShape(shape) || host.spaceId,
        documentId,
      });
    },
  },
  input: {
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
  },
};

// Static preview card. Delegates to the existing <document-attachment> custom
// element; the inline editor (<CanvasDocumentEditor>, a Vue component) stays
// host-owned and is swapped in by the host while a card is being edited. A
// plain click bubbles up as `document-click` for the host to enter edit mode;
// the card's own `open-document` event already bubbles (composed) to the host.
class CanvasDocumentElement extends CanvasElementBase {
  private card: HTMLElement | null = null;

  protected mount() {
    const card = document.createElement("document-attachment");
    card.className = "canvas-shape-document";
    dragOnPointerDown(card, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );
    card.addEventListener("wheel", (event) => event.stopPropagation());
    // Re-emit the click synchronously so the host handler still sees the
    // original event (currentTarget === the card, for checkbox hit-testing).
    card.addEventListener("click", (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.documentClick, event),
    );
    this.appendChild(card);
    this.card = card;
  }

  protected update() {
    const data = this.extra as CanvasDocumentData | null;
    const card = this.card;
    if (!card || !data) return;
    card.setAttribute("title", data.title);
    if (data.headerImage) card.setAttribute("header-image", data.headerImage);
    else card.removeAttribute("header-image");
    card.setAttribute("type", data.type);
    card.setAttribute("status", data.status);
    card.setAttribute("content", data.content);
    card.setAttribute("space-id", data.spaceId);
    card.setAttribute("document-id", data.documentId);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-document")) {
  customElements.define("canvas-document", CanvasDocumentElement);
}

export function documentLabel(doc: {
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
      x: Math.round(at.x - documentLinkElement.defaults.size.width / 2),
      y: Math.round(at.y - documentLinkElement.defaults.size.height / 2),
      width: documentLinkElement.defaults.size.width,
      height: documentLinkElement.defaults.size.height,
      rotation: 0,
    },
    style: { ...documentLinkElement.defaults.style },
    data: {
      ...documentLinkElement.defaults.data,
      text: doc ? documentLabel(doc) : documentLinkElement.defaults.data.text,
      docAddress: parsed.address,
      src: parsed.href,
    },
    updatedAt: Date.now(),
  };
}

export function initialDocumentPreview(
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

export function documentIdForShape(shape: CanvasShape): string | undefined {
  return parseVektorDocumentAddress(shapeDocumentAddress(shape))?.documentId;
}

export function documentSpaceIdForShape(
  shape: CanvasShape,
  fallbackSpaceId: string,
): string | undefined {
  return (
    parseVektorDocumentAddress(shapeDocumentAddress(shape))?.spaceId || fallbackSpaceId
  );
}

export function documentHrefForShape(shape: CanvasShape): string | undefined {
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

export function isRemoteDocumentUrl(
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

// Older canvases stored a document link as separate docId/docSpaceId/src fields
// instead of a single address. Reconstruct the canonical address from whichever
// form is present.
export function legacyDocumentAddress(
  input: { docAddress?: unknown; docId?: unknown; docSpaceId?: unknown; src?: string },
  context: { currentOrigin: string; defaultSpaceId: string },
): string | undefined {
  if (typeof input.docAddress === "string") {
    const parsed = parseVektorDocumentAddress(input.docAddress);
    if (parsed) return parsed.address;
  }
  if (typeof input.docId !== "string") return undefined;
  const href = input.src;
  let origin = context.currentOrigin;
  if (href) {
    try {
      origin = new URL(href, context.currentOrigin).origin;
    } catch {
      origin = context.currentOrigin;
    }
  }
  return createVektorDocumentAddress({
    origin,
    spaceId:
      typeof input.docSpaceId === "string" ? input.docSpaceId : context.defaultSpaceId,
    documentId: input.docId,
    href,
  });
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
// types (canvas, csv, workflow) render specialized previews, and readonly
// documents reject writes server-side.
export function previewSupportsInlineEditing(
  preview: DocumentPreviewState | undefined,
): boolean {
  if (preview?.status !== "loaded") return false;
  if (preview.readonly) return false;
  return (preview.type ?? "document") === "document";
}

export function documentShapeTitle(
  shape: CanvasShape,
  preview?: DocumentPreviewState,
): string {
  return preview?.title || shapeText(shape) || "Untitled";
}

export function normalizeDocumentReference(
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

export function dragHasDocumentLink(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types.includes(DOCUMENT_LINK_MIME));
}

export function createDocumentLinkController(options: DocumentLinkControllerOptions) {
  const previews = ref(new Map<string, DocumentPreviewState>());

  function setPreview(key: string, preview: DocumentPreviewState) {
    const next = new Map(previews.value);
    next.set(key, preview);
    previews.value = next;
  }

  function initialPreview(documentId: string): DocumentPreviewState {
    return initialDocumentPreview(documentId, options.documents.value);
  }

  function cachedPreview(shape: CanvasShape): DocumentPreviewState | undefined {
    const ref = referenceForShape(shape);
    return ref ? previews.value.get(documentReferenceKey(ref)) : undefined;
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
    const existing = previews.value.get(key);
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
      const fallback = previews.value.get(key) ?? initialPreview(parsed.documentId);
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
    const existing = previews.value.get(key);
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
      docOverride ??
      options.documents.value.find((entry) => entry.id === parsed.documentId);
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
