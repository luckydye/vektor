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
  docs: Array<Pick<DocumentWithProperties, "id" | "properties" | "type">>,
): DocumentPreviewState {
  const doc = docs.find((entry) => entry.id === documentId);
  return {
    status: "loading",
    title: doc ? documentLabel(doc) : "Untitled",
    type: doc?.type,
    content: "",
  };
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
