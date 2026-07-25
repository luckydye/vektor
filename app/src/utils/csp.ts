/**
 * Default Content-Security-Policy applied to every HTML document the app
 * serves. Set on the outgoing Node response up front (see `server.ts`),
 * so it covers both Hono-handled responses (whose `Response` headers are
 * copied onto `res` afterwards by `sendWebResponse`) and Astro-handled
 * responses (where the Astro handler writes directly to `res`).
 *
 * Routes that need a stricter / different policy (served user uploads,
 * image transforms, extension assets) set `Content-Security-Policy` on
 * their own `Response` — `sendWebResponse` then overwrites our default
 * via `res.setHeader`, so those take effect verbatim.
 *
 * Notes / limitations:
 *  - `script-src` needs `'unsafe-inline'` because Astro's astro-island
 *    hydration bootstrap (per-page `<script>` that wires the Vue islands)
 *    and `maps.astro`'s inline module script are inlined into the
 *    document. Inline handlers (`<img onerror>…`) therefore STILL
 *    execute under this policy. Until per-request nonces (or hashed
 *    inline scripts) are plumbed end-to-end through Astro + Vue, this
 *    policy is defence-in-depth against cross-origin exfiltration /
 *    resource loading, NOT a full XSS fix.
 *  - `connect-src` is closed down to same-origin + the AI providers the
 *    server/agent are wired to, plus `wss:`/`ws:` for the realtime socket.
 *    This blocks a same-origin-xss payload from shipping stolen cookies
 *    / tokens out via fetch()/sendBeacon() to an attacker's host.
 *  - `img-src` permits any `https:` image so user-embedded external
 *    images in documents still render; image-based exfil is not covered
 *    by this policy (an attacker who can inject arbitrary HTML still has
 *    the `<img src=https://attacker/?token>` channel). Tile images from
 *    the maps page also depend on this.
 *  - `frame-ancestors 'none'` — Vektor renders extensions inside a shadow
 *    DOM custom element, not via iframes, so it denies all cross-origin
 *    embedding without losing features.
 */
export const APP_CSP = [
  "default-src 'self'",
  // `platform.twitter.com` is allowed so canvas X/Twitter link cards can load
  // widgets.js and hydrate a tweet into its live embed.
  "script-src 'self' 'unsafe-inline' https://platform.twitter.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  // `https:` is intentionally broad here — same rationale as `img-src https:`
  // above. Canvas image-URL paste and the AI provider gateways (Anthropic,
  // OpenRouter, OpenAI) both need outbound fetch access, and the set of valid
  // target hosts is open-ended (user-pasted image CDNs, self-hosted LLMs, …).
  // XSS-exfil via fetch is therefore not mitigated by this directive; the
  // defence-in-depth note at the top of the file applies here too.
  "connect-src 'self' https: wss: ws:",
  "font-src 'self' data:",
  "object-src 'none'",
  // Canvas PDF previews use the browser's built-in viewer in a same-origin
  // iframe. The X/Twitter widget hydrates a tweet into an iframe served from
  // Twitter's platform/syndication hosts. Every other third-party frame stays
  // blocked.
  "frame-src 'self' https://platform.twitter.com https://syndication.twitter.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
].join("; ");

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
  "json",
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
 * JS/CSS assets must carry no CSP. Any CSP directive on a module-script
 * response (including `default-src 'none'` and `sandbox`) causes Chrome to
 * silently hang the dynamic import() promise on HTTPS origins. The page's own
 * CSP already governs what modules may be loaded; a per-module response CSP
 * adds no meaningful isolation.
 */
export const EXTENSION_ASSET_CSP_SCRIPT: string | null = null;

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
