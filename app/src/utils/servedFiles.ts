/**
 * Hardening for user-uploaded files served from the application origin.
 *
 * User content (uploads, extension assets) must never be able to run script in
 * the app origin. The danger types are SVG and HTML: when navigated to directly
 * they are rendered as active documents and any embedded `<script>` executes as
 * same-origin code (stored XSS). `<img src>` embeds are unaffected by the
 * Content-Disposition header, so forcing `attachment` for these types kills the
 * direct-navigation XSS without breaking legitimate image embedding.
 */

/** Extensions that are safe to render inline (passive content only). */
const INLINE_SAFE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "ogv",
  "pdf",
  "txt",
  "md",
  "csv",
]);

/**
 * A restrictive CSP applied to every served user file. `sandbox` strips script
 * execution, plugins, form submission, and same-origin privileges even if the
 * content is somehow rendered as a document.
 */
export const SERVED_FILE_CSP = "default-src 'none'; sandbox; base-uri 'none'";

/**
 * Compute the `Content-Disposition` for a served file. Inline-safe types are
 * served inline; everything else (notably `svg` and any `html`) is forced to
 * download so it cannot execute as a same-origin document.
 */
export function contentDisposition(extension: string | undefined): string {
  if (extension && INLINE_SAFE_EXTENSIONS.has(extension.toLowerCase())) {
    return "inline";
  }
  return "attachment";
}

/**
 * CSP for extension HTML/SVG assets. Sandboxes the document into an opaque
 * origin: `allow-scripts` lets the extension run, but the absence of
 * `allow-same-origin` means a malicious extension's HTML, when navigated to or
 * framed, cannot read the app origin's cookies/storage or issue same-origin
 * requests — defeating session theft.
 */
export const EXTENSION_ASSET_CSP = "sandbox allow-scripts allow-popups allow-forms";

/**
 * CSP for extension JS/CSS assets loaded via dynamic import() or <link>.
 * We intentionally do NOT include `sandbox` here: Chrome hangs the import()
 * promise indefinitely when a module script response carries CSP sandbox on
 * HTTPS origins. JS runs in the page context anyway, so the sandbox would not
 * add meaningful isolation.
 */
export const EXTENSION_ASSET_CSP_SCRIPT = "default-src 'none'";

/** Security headers applied to all served user files. */
export function servedFileSecurityHeaders(
  extension: string | undefined,
): Record<string, string> {
  return {
    "Content-Disposition": contentDisposition(extension),
    "Content-Security-Policy": SERVED_FILE_CSP,
    "X-Content-Type-Options": "nosniff",
  };
}
