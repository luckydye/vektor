import type { SelectMenuItem } from "#components/SelectMenu.tsx";
import { type DocumentProperties, propertyValueToText } from "#documents/properties.ts";
import { t } from "#utils/lang.ts";
import { documentTypeIcon } from "./icons.ts";

/**
 * What a document is called in a list.
 *
 * Its own module rather than `properties.ts`, which the server imports and
 * which therefore stays free of the client's i18n.
 */
export function documentTitle(
  document: {
    properties?: DocumentProperties | null;
  },
  lang: string,
): string {
  const title = document.properties?.title;
  return title ? propertyValueToText(title) : t("Untitled", lang);
}

/** A document as a pick of a "document" property, which stores the referenced document's id. */
export function documentOption(
  document: { id: string; type?: string | null; properties?: DocumentProperties | null },
  lang: string,
): SelectMenuItem {
  return {
    id: document.id,
    label: documentTitle(document, lang),
    icon: documentTypeIcon(document.type),
  };
}
