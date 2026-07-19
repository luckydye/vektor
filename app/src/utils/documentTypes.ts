/** Hidden, immutable system document created for each workflow execution. */
export const workflowRunDocumentType = "workflow-run";

export const readOnlyDocumentTypes: readonly string[] = ["csv", workflowRunDocumentType];

/**
 * Document types whose stored content is serialized JSON rather than HTML
 * (canvas and app persist their own document models). HTML sanitization such
 * as script-tag stripping is both meaningless and expensive on these — a
 * canvas reaches tens of MB — so the save path skips it for them.
 */
export const nonHtmlContentDocumentTypes: readonly string[] = ["canvas", "app"];

/** Whether a document type's stored content should be treated as HTML. */
export function contentIsHtml(type: string | null | undefined): boolean {
  return !nonHtmlContentDocumentTypes.includes(type ?? "document");
}

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
