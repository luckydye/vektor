import { slugify } from "#utils/slug.ts";

/** Hidden, immutable system document created for each workflow execution. */
export const workflowRunDocumentType = "workflow-run";

export const readOnlyDocumentTypes: readonly string[] = ["csv", workflowRunDocumentType];

/** Whether a document is locked explicitly or immutable because of its type. */
export function documentIsReadonly(document: {
  readonly?: boolean;
  type?: string | null;
}): boolean {
  return (
    Boolean(document.readonly) || readOnlyDocumentTypes.includes(document.type ?? "")
  );
}

/**
 * Document types whose stored content is serialized JSON rather than HTML
 * (canvas, app, and workflow persist their own document models). HTML sanitization such
 * as script-tag stripping is both meaningless and expensive on these — a
 * canvas reaches tens of MB — so the save path skips it for them.
 */
export const nonHtmlContentDocumentTypes: readonly string[] = [
  "canvas",
  "app",
  "workflow",
];

/** Whether a document type's stored content should be treated as HTML. */
export function contentIsHtml(type: string | null | undefined): boolean {
  return !nonHtmlContentDocumentTypes.includes(type ?? "document");
}

/**
 * Optional child-type policies for document types. Types omitted from this map
 * may parent any document type; a present empty list forbids all children.
 */
export const allowedChildDocumentTypes: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["workflow", [workflowRunDocumentType]],
  ["database", ["record"]],
  [workflowRunDocumentType, []],
]);

export function allowsChildDocumentType(
  parentType: string | null | undefined,
  childType: string | null | undefined,
): boolean {
  const allowedTypes = allowedChildDocumentTypes.get(parentType ?? "document");
  return allowedTypes === undefined || allowedTypes.includes(childType ?? "document");
}

/**
 * Document types that support the comments overlay. Comments are anchored to
 * rich-text content, so only text-based documents are applicable — canvas,
 * app, csv and workflow docs have no commentable text layer. A missing/null
 * type defaults to "document".
 */
export const commentableDocumentTypes: readonly string[] = ["document"];
export const documentEditorTypes: readonly string[] = ["document", "workflow", "record"];

export function supportsComments(type: string | null | undefined): boolean {
  return commentableDocumentTypes.includes(type ?? "document");
}

export function supportsDocumentEditor(type: string | null | undefined): boolean {
  return documentEditorTypes.includes(type ?? "document");
}

/**
 * What a document is called when it is created before the user has named it.
 *
 * Shared with the server because a slug derived from one of these says nothing
 * about the document — it is the one slug a rename may still replace.
 */
const placeholderDocumentTitles: Readonly<Record<string, string>> = {
  document: "Untitled Document",
  canvas: "Untitled Canvas",
  database: "Untitled Database",
  workflow: "Untitled Workflow",
  csv: "Untitled Spreadsheet",
};

export function placeholderDocumentTitle(type: string | null | undefined): string {
  return placeholderDocumentTitles[type ?? "document"] ?? "Untitled";
}

const placeholderSlugs = new Set(
  [...Object.values(placeholderDocumentTitles), "Untitled"].map(slugify),
);

/**
 * The slug a title the URL cannot carry falls back to. Built here, next to
 * {@link isPlaceholderDocumentSlug}, so the two agree on the shape.
 */
export function fallbackDocumentSlug(uniquePart: string): string {
  return `document-${uniquePart.slice(-8)}`;
}

const fallbackSlugPattern = /^document-[0-9a-f]{8}$/;

/**
 * Whether a slug still comes from a placeholder title rather than one somebody
 * chose. The uniquifier the generator appends ("-2") belongs to the placeholder
 * just as much, so it stays replaceable too.
 *
 * A generated fallback slug counts, since `document-1a2b3c4d` says even less
 * about the document than `untitled-document` does.
 */
export function isPlaceholderDocumentSlug(slug: string): boolean {
  // Before stripping the uniquifier too: a fallback slug can end in digits.
  if (fallbackSlugPattern.test(slug)) return true;
  const base = slug.replace(/-\d+$/, "");
  return placeholderSlugs.has(base) || fallbackSlugPattern.test(base);
}
