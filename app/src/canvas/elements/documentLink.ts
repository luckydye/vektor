import { ref, type Ref } from "vue";
import type { DocumentWithProperties } from "../../api/ApiClient.ts";
import type { CanvasElementDefinition, CanvasShape } from "./types.ts";

export const DOCUMENT_ID_MIME = "application/x-vektor-document-id";

export type DocumentPreviewState = {
  status: "loading" | "loaded" | "error";
  title: string;
  type?: string | null;
  content: string;
  error?: string;
};

type DocumentPreviewSource = Pick<
  DocumentWithProperties,
  "id" | "properties" | "type"
>;

type LoadedDocumentPreviewSource = DocumentPreviewSource & {
  content?: unknown;
};

export type DocumentLinkControllerOptions = {
  documents: Ref<DocumentPreviewSource[]>;
  fetchDocument: (documentId: string) => Promise<LoadedDocumentPreviewSource>;
  insertShape: (shape: CanvasShape) => void;
  selectShape: (shapeId: string) => void;
  afterInsert?: () => void;
};

export const documentLinkElement: CanvasElementDefinition = {
  type: "document",
  defaultText: "Untitled",
  defaultColor: "var(--canvas-doc-bg)",
  defaultSize: { width: 380, height: 280 },
  minSize: { width: 280, height: 180 },
  isValid: (shape) => Boolean(shape.docId),
};

export function documentLabel(doc: {
  properties?: { title?: string | null } | null;
}): string {
  const title = doc.properties?.title;
  return title?.trim() ? title.trim() : "Untitled";
}

export function createDocumentLinkShape(
  documentId: string,
  at: { x: number; y: number },
  doc?: Pick<DocumentWithProperties, "properties">,
): CanvasShape | null {
  const linkedDocumentId = documentId.trim();
  if (!linkedDocumentId) return null;

  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "document",
    x: Math.round(at.x - documentLinkElement.defaultSize.width / 2),
    y: Math.round(at.y - documentLinkElement.defaultSize.height / 2),
    width: documentLinkElement.defaultSize.width,
    height: documentLinkElement.defaultSize.height,
    text: doc ? documentLabel(doc) : documentLinkElement.defaultText,
    color: documentLinkElement.defaultColor,
    docId: linkedDocumentId,
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
  return shape.docId;
}

export function documentShapeTitle(
  shape: CanvasShape,
  preview?: DocumentPreviewState,
): string {
  return preview?.title || shape.text || "Untitled";
}

export function isCanvasSnapshotContent(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(content) as { version?: unknown; shapes?: unknown };
    return parsed?.version === 1 && Array.isArray(parsed.shapes);
  } catch {
    return false;
  }
}

export function documentShapeContentHtml(preview?: DocumentPreviewState): string {
  const content = preview?.content.trim() ?? "";
  if (!content || preview?.type === "canvas" || isCanvasSnapshotContent(content)) {
    return "";
  }
  return content;
}

export function documentShapeFallback(preview?: DocumentPreviewState): string {
  if (!preview || preview.status === "loading") return "Loading document content...";
  if (preview.status === "error") return "Unable to load document content.";
  if (preview.type === "canvas") return "Canvas document";
  return "No document content";
}

export function droppedDocumentId(
  transfer: DataTransfer | null,
  knownDocuments: Array<Pick<DocumentWithProperties, "id">>,
): string | null {
  if (!transfer) return null;
  const typed = transfer.getData(DOCUMENT_ID_MIME).trim();
  if (typed) return typed;

  const plain = transfer.getData("text/plain").trim();
  if (!plain) return null;
  return knownDocuments.some((doc) => doc.id === plain) ? plain : null;
}

export function dragHasDocumentLink(transfer: DataTransfer | null): boolean {
  return Boolean(
    transfer?.types.includes(DOCUMENT_ID_MIME) || transfer?.types.includes("text/plain"),
  );
}

export function createDocumentLinkController(
  options: DocumentLinkControllerOptions,
) {
  const previews = ref(new Map<string, DocumentPreviewState>());

  function setPreview(documentId: string, preview: DocumentPreviewState) {
    const next = new Map(previews.value);
    next.set(documentId, preview);
    previews.value = next;
  }

  function initialPreview(documentId: string): DocumentPreviewState {
    return initialDocumentPreview(documentId, options.documents.value);
  }

  function cachedPreview(shape: CanvasShape): DocumentPreviewState | undefined {
    const documentId = documentIdForShape(shape);
    return documentId ? previews.value.get(documentId) : undefined;
  }

  async function loadPreview(documentId: string) {
    const existing = previews.value.get(documentId);
    if (existing?.status === "loading" || existing?.status === "loaded") return;

    setPreview(documentId, initialPreview(documentId));

    try {
      const doc = await options.fetchDocument(documentId);
      setPreview(documentId, {
        status: "loaded",
        title: initialDocumentPreview(documentId, [doc]).title,
        type: doc.type,
        content: typeof doc.content === "string" ? doc.content : "",
      });
    } catch (error) {
      const fallback = previews.value.get(documentId) ?? initialPreview(documentId);
      setPreview(documentId, {
        ...fallback,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function shapeTitle(shape: CanvasShape): string {
    return documentShapeTitle(shape, cachedPreview(shape));
  }

  function shapeContentHtml(shape: CanvasShape): string {
    return documentShapeContentHtml(cachedPreview(shape));
  }

  function shapeFallback(shape: CanvasShape): string {
    return documentShapeFallback(cachedPreview(shape));
  }

  // Places a card on the canvas that links to another document by stable id.
  function insertDocumentLink(
    documentId: string,
    at: { x: number; y: number },
  ): boolean {
    const doc = options.documents.value.find(
      (entry) => entry.id === documentId.trim(),
    );
    const shape = createDocumentLinkShape(documentId, at, doc);
    if (!shape) return false;

    options.insertShape(shape);
    options.selectShape(shape.id);
    if (shape.docId) void loadPreview(shape.docId);
    options.afterInsert?.();
    return true;
  }

  return {
    previews,
    cachedPreview,
    initialPreview,
    loadPreview,
    documentIdForShape,
    shapeTitle,
    shapeContentHtml,
    shapeFallback,
    insertDocumentLink,
  };
}
