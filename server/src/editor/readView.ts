import docStyles from "#editor/css/document.css?inline";
import { sanitizeDocumentHtml } from "#utils/html.ts";

function escapeRawTextElement(value: string) {
  return value.replace(/<\/(script|style)/gi, "<\\/$1");
}

interface DocumentReadOptions {
  readonly?: boolean;
}

/**
 * Server-side twin of DocumentView.renderReadHtml.
 *
 * Keeping the declarative shadow root here lets every server-rendered document
 * use the same structure, styles, and sanitization as the hydrated app view.
 */
export function renderDocumentReadShadowHtml(
  html: string,
  options: DocumentReadOptions = {},
): string {
  return [
    '<template shadowrootmode="open">',
    `<style data-document-styles>${escapeRawTextElement(docStyles)}</style>`,
    '<div part="content"><div>',
    renderDocumentReadHtml(html, options),
    "</div></div>",
    "</template>",
  ].join("");
}

/** Sanitizes stored document HTML for the shared read-mode renderer. */
export function renderDocumentReadHtml(
  html: string,
  options: DocumentReadOptions = {},
): string {
  const sanitized = sanitizeDocumentHtml(html);
  if (!options.readonly) return sanitized;

  // The sanitizer emits canonical input tags, making this a safe final render
  // transform. The marker lets a live DocumentView restore only controls it
  // disabled itself if the same element later becomes editable.
  return sanitized.replace(
    /<input(?=[^>]*\btype="checkbox"(?:\s|>))([^>]*)>/gu,
    (input, attributes: string) =>
      /\sdisabled(?:\s|=|>)/u.test(input)
        ? input
        : `<input${attributes} data-document-readonly-disabled disabled>`,
  );
}
