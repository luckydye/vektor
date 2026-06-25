export const readOnlyDocumentTypes: readonly string[] = ["csv"];

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
