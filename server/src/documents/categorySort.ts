/**
 * How the sidebar orders the documents listed under a category.
 *
 * Free of the client's i18n, as the server imports it to validate a category.
 */
export const CATEGORY_DOCUMENT_SORTS = ["alphanumeric", "updated", "created"] as const;

export type CategoryDocumentSort = (typeof CATEGORY_DOCUMENT_SORTS)[number];

export const DEFAULT_CATEGORY_DOCUMENT_SORT: CategoryDocumentSort = "alphanumeric";

export function isCategoryDocumentSort(value: unknown): value is CategoryDocumentSort {
  return (
    typeof value === "string" &&
    (CATEGORY_DOCUMENT_SORTS as readonly string[]).includes(value)
  );
}

interface SortableDocument {
  createdAt: Date | string;
  updatedAt: Date | string;
}

const timestamp = (value: Date | string) => new Date(value).getTime() || 0;

/**
 * A comparator for `sort`: newest first for the time-based sorts, falling back
 * to the title so documents sharing a timestamp keep a stable order.
 */
export function categoryDocumentComparator<T extends SortableDocument>(
  sort: CategoryDocumentSort | undefined,
  title: (document: T) => string,
  lang: string,
): (left: T, right: T) => number {
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });
  const byTitle = (left: T, right: T) => collator.compare(title(left), title(right));

  switch (sort) {
    case "updated":
      return (left, right) =>
        timestamp(right.updatedAt) - timestamp(left.updatedAt) || byTitle(left, right);
    case "created":
      return (left, right) =>
        timestamp(right.createdAt) - timestamp(left.createdAt) || byTitle(left, right);
    default:
      return byTitle;
  }
}

/**
 * Reads `documentSort` and `documentLimit` from a request body. Null or an
 * absent field clears the setting; anything else invalid is an error message.
 */
export function parseCategoryDocumentListing(
  body: Record<string, unknown>,
):
  | { documentSort?: CategoryDocumentSort; documentLimit?: number }
  | { error: string } {
  const { documentSort, documentLimit } = body;

  if (documentSort != null && !isCategoryDocumentSort(documentSort)) {
    return {
      error: `documentSort must be one of: ${CATEGORY_DOCUMENT_SORTS.join(", ")}`,
    };
  }
  if (
    documentLimit != null &&
    (typeof documentLimit !== "number" ||
      !Number.isInteger(documentLimit) ||
      documentLimit < 1)
  ) {
    return { error: "documentLimit must be a positive integer" };
  }

  return {
    documentSort: documentSort ?? undefined,
    documentLimit: documentLimit ?? undefined,
  };
}
