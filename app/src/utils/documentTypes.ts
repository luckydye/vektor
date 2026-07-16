/** Hidden, immutable system document created for each workflow execution. */
export const workflowRunDocumentType = "workflow-run";

export const readOnlyDocumentTypes: readonly string[] = ["csv", workflowRunDocumentType];

/**
 * Optional child-type policies for document types. Types omitted from this map
 * may parent any document type; a present empty list forbids all children.
 */
export const allowedChildDocumentTypes: Readonly<Record<string, readonly string[]>> = {
  workflow: [workflowRunDocumentType],
  database: ["record"],
  [workflowRunDocumentType]: [],
};

export function allowsChildDocumentType(
  parentType: string | null | undefined,
  childType: string | null | undefined,
): boolean {
  const allowedTypes = allowedChildDocumentTypes[parentType ?? "document"];
  return allowedTypes === undefined || allowedTypes.includes(childType ?? "document");
}

/**
 * Document types that support the comments overlay. Comments are anchored to
 * rich-text content, so only text-based documents are applicable — canvas,
 * app, csv and workflow docs have no commentable text layer. A missing/null
 * type defaults to "document".
 */
export const commentableDocumentTypes: readonly string[] = ["document"];
export const documentEditorTypes: readonly string[] = ["document", "workflow"];

export function supportsComments(type: string | null | undefined): boolean {
  return commentableDocumentTypes.includes(type ?? "document");
}

export function supportsDocumentEditor(type: string | null | undefined): boolean {
  return documentEditorTypes.includes(type ?? "document");
}
