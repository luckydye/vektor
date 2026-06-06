/**
 * Comment references come in three shapes:
 * - a JSON envelope `{"selector": "...", "rev": 3}` wrapping a selector
 * - a CSS selector / element id anchoring the comment to an element
 * - a plain number: a y offset in px relative to the top of the
 *   `document-view` content (scroll-independent)
 */

/** Unwrap the `{selector, rev}` JSON envelope if present. */
export function resolveReferenceSelector(reference: string): string {
  if (reference.startsWith("{")) {
    try {
      const parsed = JSON.parse(reference);
      if (typeof parsed?.selector === "string") return parsed.selector;
    } catch {}
  }
  return reference;
}

/** True if the reference is a y-position (numeric) reference. */
export function isPositionReference(reference: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(reference);
}
