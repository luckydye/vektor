import { propertyValueToText } from "#documents/properties.ts";
import { t } from "#utils/lang.ts";
import type { DocumentPropertyValue } from "./properties.ts";

/**
 * What a document is called in a list.
 *
 * Its own module rather than `properties.ts`, which the server imports and
 * which therefore stays free of the client's i18n.
 */
export function documentTitle(document: {
  properties?: Record<string, DocumentPropertyValue> | null;
}): string {
  const title = document.properties?.title;
  return title ? propertyValueToText(title) : t("Untitled");
}
