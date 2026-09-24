/**
 * Property that marks a document as a reusable template. The leading
 * underscore keeps it out of the property UI (see
 * `isHiddenDocumentPropertyKey`), so a template carries the marker without
 * growing a row somebody can edit by hand.
 */
export const templatePropertyKey = "_template";

/**
 * Value stored under the marker. A property filter without a value means "has
 * a non-empty value for this key", so the marker cannot be stored as "" — it
 * would be indistinguishable from a document that never had one.
 */
export const templatePropertyValue = "true";

/** A template as the new-document picker offers it. */
export interface DocumentTemplate {
  id: string;
  title: string;
  /** First line of the template body, shown beneath the title. */
  description: string;
  /** The template body, inserted into the document the user is writing. */
  content: string;
}
