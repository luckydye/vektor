import { type Ref, ref } from "vue";
import "#editor/elements/document-attachment.ts";
import type { DocumentWithProperties } from "#api/ApiClient.ts";
import {
  type ParsedVektorDocumentAddress,
  parseVektorDocumentAddress,
  type VektorDocumentAddress,
} from "#utils/documentAddress.ts";
import {
  type DocumentPropertyValue,
  propertyValueToText,
} from "#utils/documentProperties.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "./CanvasElementBase.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

export const DOCUMENT_LINK_MIME = "application/x-vektor-document-link";

export type DocumentLinkReference = {
  address: VektorDocumentAddress;
};

export type DocumentPreviewState = {
  status: "loading" | "loaded" | "error";
  title: string;
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

export const documentLinkElement: CanvasElementExtension = {
  type: "document",
  defaultText: "Untitled",
  defaultColor: "var(--canvas-doc-bg)",
  defaultSize: { width: 380, height: 280 },
  minSize: { width: 280, height: 180 },
  isValid: (shape) => Boolean(parseVektorDocumentAddress(shape.docAddress)),
  surface: "dom",
  tag: "canvas-document",
  // Embedded document cards resize but do not rotate.
  transform: { move: true, resize: "box", rotate: false },
};

// Reactive view model the host resolves from the document-link preview
// controller and hands to <canvas-document> via its `data` property.
export type CanvasDocumentData = {
  title: string;
  type: string;
  status: string;
  content: string;
  spaceId: string;
  documentId: string;
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
    card.setAttribute("type", data.type);
    card.setAttribute("status", data.status);
    card.setAttribute("content", data.content);
    card.setAttribute("space-id", data.spaceId);
    card.setAttribute("document-id", data.documentId);
  }

  protected teardown() {
    this.card = null;
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
    x: Math.round(at.x - documentLinkElement.defaultSize.width / 2),
    y: Math.round(at.y - documentLinkElement.defaultSize.height / 2),
    width: documentLinkElement.defaultSize.width,
    height: documentLinkElement.defaultSize.height,
    rotation: 0,
    text: doc ? documentLabel(doc) : documentLinkElement.defaultText,
    color: documentLinkElement.defaultColor,
    docAddress: parsed.address,
    src: parsed.href,
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
    type: doc?.type,
    content: "",
  };
}

export function documentIdForShape(shape: CanvasShape): string | undefined {
  return parseVektorDocumentAddress(shape.docAddress)?.documentId;
}

export function documentSpaceIdForShape(
  shape: CanvasShape,
  fallbackSpaceId: string,
): string | undefined {
  return parseVektorDocumentAddress(shape.docAddress)?.spaceId || fallbackSpaceId;
}

export function documentHrefForShape(shape: CanvasShape): string | undefined {
  return parseVektorDocumentAddress(shape.docAddress)?.href ?? shape.src;
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
  return preview?.title || shape.text || "Untitled";
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
    return normalizeDocumentReference(shape.docAddress);
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
    shapeStatus,
    shapeType,
    shapeContent,
    setPreviewContent,
    insertDocumentLink,
  };
}
