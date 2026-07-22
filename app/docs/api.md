# Vektor API (`/api/v1`)

REST API for Vektor spaces, documents, extensions, and workflows. All endpoints are
mounted under `/api/v1` and registered file-by-file in `src/api/routes.ts`; each route
file exports one function per HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
`HEAD`, or a catch-all `ALL`). Bracketed path segments (`[spaceId]`) are dynamic params;
`[...path]` segments are catch-alls that match one or more remaining segments.

Non-`/api/v1` auth (`/api/auth/[...all]`, better-auth) and CalDAV routes
(`/api/caldav/...`, `/.well-known/caldav`, `/.well-known/vektor`) exist alongside this
API but are out of scope for this document.

## Auth models

Most endpoints accept one or more of:

- **Session cookie** — logged-in browser user (`requireUser` / session-based checks).
- **Access token** — `Authorization: Bearer at_<token>`. Long-lived, scoped via ACL
  grants (`token:<tokenId>` identity) to specific resources/permissions. Created via
  the access-tokens endpoints.
- **Public/unauthenticated** — permitted only where the space (or document/category)
  grants the `public` group a role.

Role hierarchy (space/document/category level): `viewer` < `editor` < `owner`. Some
actions additionally gate on a **feature** flag independent of role: `comment`,
`view_history`, `view_audit`, `manage_extensions` (see `Feature` enum in
`src/db/acl.ts`); features can be granted/denied per user or group regardless of role,
though roles have sane feature defaults (e.g. owner has all).

`ResourceType` values used in ACL/token grants: `space`, `document`, `document_tree`,
`category`, `extension`, `secret`, `feature`.

## Error format

Errors are always `{ "error": "message" }` with a matching HTTP status. Common codes:

- `400` — bad request (missing/invalid params or body)
- `401` — unauthorized (no/invalid credential)
- `403` — forbidden (authenticated but lacks role/feature)
- `404` — not found
- `405` — method not allowed (`Allow` header lists supported methods)
- `500` — internal server error

Success bodies vary by endpoint; many wrap the payload in a named key (`{ document }`,
`{ space }`, `{ categories }`, etc.) — see per-endpoint sections below.

---

## Quick summary

| Method | Path | What it does |
|---|---|---|
| GET/POST | `/auth/cli` | Browser-based CLI login (approval page / code issuance) |
| POST | `/auth/cli/token` | Exchange CLI one-time code for an access token |
| POST | `/chat/acp` | Agent Control Protocol JSON-RPC endpoint (streaming AI chat turns) |
| POST | `/chat/completions` | OpenAI/Anthropic/Ollama-compatible chat completions proxy |
| GET | `/url-metadata` | Fetch link-preview metadata (OpenGraph/oEmbed/internal doc) |
| GET | `/proxy-media` | Proxy remote video/audio for canvas embeds (SSRF-safe) |
| GET | `/users` | Minimal public profile lookup (`?id=` or `?spaceId=`) |
| GET | `/users/me` | Current user profile |
| GET/POST | `/spaces` | List spaces / create a space |
| GET/PATCH/DELETE | `/spaces/:spaceId` | Read / update / delete a space |
| GET | `/spaces/:spaceId/members` | List space members with roles |
| GET | `/spaces/:spaceId/properties` | List all document property keys/values in space |
| GET | `/spaces/:spaceId/audit-logs` | Space-wide audit log (paginated) |
| GET/POST/PUT | `/spaces/:spaceId/categories` | List / create / reorder categories |
| GET/PUT/DELETE | `/spaces/:spaceId/categories/:id` | Read / update / delete a category |
| GET/POST | `/spaces/:spaceId/permissions` | List / grant-deny-revoke roles & features |
| GET | `/spaces/:spaceId/permissions/me` | Caller's role + feature flags in this space |
| GET | `/spaces/:spaceId/search` | Full-text/semantic document search |
| POST | `/spaces/:spaceId/search/rebuild` | Rebuild the space's search embeddings |
| GET/POST | `/spaces/:spaceId/access-tokens` | List / create access tokens |
| GET/PATCH/DELETE | `/spaces/:spaceId/access-tokens/:tokenId` | Read / revoke / delete a token |
| PUT/DELETE | `/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId` | Grant/revoke token access to a resource |
| GET/POST | `/spaces/:spaceId/uploads` | List uploaded files / upload a new file |
| GET/DELETE | `/spaces/:spaceId/uploads/*path` | Serve (with transforms/range) / delete an uploaded file |
| GET/POST | `/spaces/:spaceId/secrets` | List secret names / create a secret |
| GET/PUT/DELETE/HEAD | `/spaces/:spaceId/secrets/:name` | Read / upsert / delete / check existence of a secret |
| GET/PUT/DELETE | `/spaces/:spaceId/settings/ai-provider` | Read / set / clear the space's AI provider config |
| GET | `/spaces/:spaceId/integrations` | List OAuth integration connection states |
| GET/DELETE | `/spaces/:spaceId/integrations/:provider` | Read / disconnect a single integration |
| POST | `/spaces/:spaceId/integrations/:provider/connect` | Start OAuth authorization flow |
| GET | `/spaces/:spaceId/integrations/:provider/callback` | OAuth redirect callback (browser) |
| POST | `/spaces/:spaceId/integrations/:provider/proxy` | Proxy an authenticated request to the integration's API |
| POST | `/spaces/:spaceId/jobs/run` | Run a single extension job (sync or SSE stream) |
| GET | `/spaces/:spaceId/jobs/runs` | List job execution history |
| GET/POST | `/spaces/:spaceId/workflows/runs` | Get/list workflow runs / start a workflow run |
| GET/POST/DELETE | `/spaces/:spaceId/workflows/runs/:runId` | Read a run / cancel it (POST or DELETE) |
| GET/POST | `/spaces/:spaceId/workflows/schedules` | List / create cron schedules for workflow documents |
| GET/PATCH/DELETE | `/spaces/:spaceId/workflows/schedules/:scheduleId` | Read / update / delete a workflow schedule |
| GET | `/spaces/:spaceId/ai-chat/sessions` | List the caller's AI chat sessions |
| GET/PUT/DELETE | `/spaces/:spaceId/ai-chat/sessions/:sessionId` | Read / save / delete an AI chat session |
| GET/POST | `/spaces/:spaceId/documents` | List documents (with filters) / create a document |
| GET | `/spaces/:spaceId/documents/archived` | List archived (soft-deleted) documents |
| GET/PUT/PATCH/DELETE/POST | `/spaces/:spaceId/documents/:documentId` | Read / replace content / patch metadata / archive-delete / create revision |
| GET | `/spaces/:spaceId/documents/:documentId/children` | List direct child documents |
| GET | `/spaces/:spaceId/documents/:documentId/breadcrumbs` | Ancestor chain for a document |
| GET | `/spaces/:spaceId/documents/:documentId/contributors` | Users who have edited the document |
| GET/POST/PATCH/DELETE | `/spaces/:spaceId/documents/:documentId/comments` | List / create / update / delete comments |
| GET | `/spaces/:spaceId/documents/:documentId/diff` | Unified/inline diff between a revision and its base |
| POST | `/spaces/:spaceId/documents/:documentId/edit` | Apply structured partial edit operations (live-merge aware) |
| GET/PATCH | `/spaces/:spaceId/documents/:documentId/email-preference` | Read / set per-user email-mute for a document |
| GET | `/spaces/:spaceId/documents/:documentId/audit-logs` | Document-scoped audit log |
| GET/POST/PATCH | `/spaces/:spaceId/documents/:documentId/revisions` | List revisions / restore a revision / update suggestion status |
| GET/POST | `/spaces/:spaceId/extensions` | List extensions / upload (install or update) an extension package |
| GET/PATCH/DELETE | `/spaces/:spaceId/extensions/:extensionId` | Read / enable-disable / delete an extension |
| GET | `/spaces/:spaceId/extensions/:extensionId/package` | Download the raw extension ZIP |
| GET | `/spaces/:spaceId/extensions/:extensionId/assets/*path` | Serve a static asset from the extension package |

---

## Auth — CLI login

### `GET /auth/cli`

- **Auth**: session cookie (browser). Redirects with `error` param if unauthenticated
  behavior isn't applicable — actually requires a session; unauthenticated calls 401.
- **Query**: `redirect_uri` (must be `http://localhost:<port>/callback` or
  `http://127.0.0.1:<port>/callback`), `state` (string, ≥16 chars).
- **Behavior**: renders an HTML "Allow Vektor CLI Access" approval page listing the
  user's spaces. Creates a short-lived (5 min) in-memory approval token embedded in
  the form.
- **Returns**: `text/html` page, or a `302` redirect to the CLI callback with
  `?error=no_spaces` if the user has no spaces.

### `POST /auth/cli`

- **Auth**: session cookie.
- **Body** (form-encoded): `redirect_uri`, `state`, `approval` (from the GET page),
  `intent` (`allow` | `cancel`), `spaceId` (required when `intent=allow`).
- **Behavior**: validates the approval token (single-use, 5 min TTL, must match user/
  redirect_uri/state), generates a one-time code (60s TTL) bound to `{userId, spaceId}`.
- **Returns**: `text/html` redirect-bounce page whose script navigates to
  `redirect_uri?state=...&code=...&space=<spaceId>` (or `?error=access_denied` /
  `no_spaces`).

### `POST /auth/cli/token`

- **Auth**: none — the one-time `code` itself is the credential.
- **Body**: `{ code: string }`.
- **Behavior**: single-use, 60s-TTL code lookup; on success mints a new access token
  for the associated space (editor permission on the whole space, named
  `CLI (<date>)`), no expiry.
- **Returns**: `200 { token: string, spaceId: string }`. `400` for invalid/expired code.

---

## Chat

### `POST /chat/acp`

Agent Control Protocol JSON-RPC 2.0 endpoint driving the in-app AI chat agent.

- **Auth**: session or access token, authenticated as viewer-or-above on the space.
- **Body**: `{ jsonrpc: "2.0", id?, method, params }`. Supported `method`s:
  - `session/prompt` — params: `sessionId` (string, required), `spaceId` (string,
    required), `documentId?` (string), `additionalContext?` (string), `prompt`
    (non-empty array whose first element has a `text: string` field). Starts or
    reattaches to a live agent turn keyed by `spaceId:userId:chatId`; the turn
    survives client disconnects. Loads/updates conversation history, user profile,
    and connected OAuth providers from the DB (for session-authenticated calls).
    **Returns**: `text/event-stream` — replays buffered `session/update`
    notifications then streams new ones (`agent_message_chunk`, `generic`
    (`thinking`), `plan`, `tool_call`, `tool_call_update`), ending with a final
    JSON-RPC `result: { stopReason: "end_turn" }` or `error`, then `data: [DONE]`.
  - `session/cancel` — params: `sessionId`, `spaceId` (both required). Aborts the
    in-progress turn for that key. **Returns**: `200 { jsonrpc, id, result: { cancelled: true } }`.
- Any other `method` → `400`.

### `POST /chat/completions`

- **Auth**: session cookie.
- **Headers**: `X-Space-Id` (required).
- **Body**: passthrough OpenAI-style chat completion request; the server injects
  `model` for OpenAI-compatible providers.
- **Behavior**: looks up the space's configured AI provider
  (`anthropic`/`ollama`/OpenAI-compatible) and proxies the request, streaming the
  upstream response back verbatim (SSE or JSON depending on upstream). Logs (but does
  not alter) upstream error bodies.
- **Returns**: proxied upstream status/body; `Content-Type` preserved (default
  `application/json`), `Cache-Control: no-cache`.

---

## URL metadata / media proxy

### `GET /url-metadata`

- **Auth**: session (`requireUser`) — prevents anonymous SSRF probing.
- **Query**: `url` (required).
- **Behavior**: three resolution paths, in order:
  1. **Internal URL** (same host as request origin, path `/{spaceSlug}/doc/{slug}`) —
     looks up the space/document and enforces `verifyDocumentAccess`; cached 2 min.
  2. **Remote Vektor document** (`/{spaceSlug}/doc/{slug}` on another Vektor
     instance) — discovered via `/.well-known/vektor`, fetches its public document
     API; cached 2 min.
  3. **X/Twitter status URL** — resolved via `publish.x.com/oembed` (script-free);
     cached 10 min.
  4. **Generic external URL** — scrapes OpenGraph/meta tags (`title`, `description`,
     `image`, `video`, `siteName`, `favicon`), following ≤3 redirects, each
     SSRF-validated; cached 10 min.
- **Returns**: `200` `LinkMetadata` JSON (`url, title, description, image, video,
  siteName, favicon, updatedAt, fetchedAt`, plus optional `embed` or `vektorDocument`).
  `400` for invalid/SSRF-blocked URLs or access-denied internal docs.

### `GET /proxy-media`

- **Auth**: session (`requireUser`).
- **Query**: `url` (required).
- **Behavior**: SSRF-validates the URL, forwards `Range` header, only relays
  responses whose `Content-Type` starts with `video/` or `audio/` (else `400`).
  Forwards `content-type/-length/-range`, `accept-ranges`; sets
  `cache-control: public, max-age=3600, immutable`. 15s timeout.
- **Returns**: proxied status + body (supports partial/`206` range responses via the
  upstream response).

---

## Users

### `GET /users`

- **Auth**: session (`requireUser`).
- **Query**: exactly one of `id` (single user) or `spaceId` (space members). Neither
  → `400`. A bare listing of all users is intentionally not supported.
- **Behavior (`id`)**: returns `{ id, name, image }` for that user, `404` if none.
- **Behavior (`spaceId`)**: `verifySpaceAccess` (viewer), returns array of
  `{ id, name, image }` for all space members (ACL member ids + creator).
- Email is never included (PII).

### `GET /users/me`

- **Auth**: session (`requireUser`).
- **Returns**: `200 { id, name, email, image }`.

---

## Spaces

### `GET /spaces`

- **Auth**: any of access token / session / unauthenticated.
- **Behavior**: if a bearer access token is present, returns the single space it's
  scoped to (or `[]`); else if a session exists, returns all spaces the user belongs
  to (`listUserSpaces`); else returns spaces with `public` viewer access.
- **Returns**: `200` array of space objects.

### `POST /spaces`

- **Auth**: session (`requireUser`).
- **Body**: `name` (string, required), `slug` (string, required), `preferences?`
  (object, ≤512KB serialized).
- **Returns**: `201 { space }`. `400` if slug already exists or missing fields;
  `503` if no hosted database is available.

### `GET /spaces/:spaceId`

- **Auth**: session + `verifySpaceRole(viewer)`.
- **Returns**: `200` space object (or whatever `getSpace` yields, including `null`
  body if deleted mid-request).

### `PATCH /spaces/:spaceId`

- **Auth**: session; `owner` role required to change `name`/`slug`, `editor` role
  sufficient for `preferences`-only updates.
- **Body**: at least one of `name` (non-empty string), `slug` (non-empty string),
  `preferences` (object, ≤512KB).
- **Returns**: `200` updated space object. `400` if none of the three fields given,
  invalid types, or slug collision.

### `DELETE /spaces/:spaceId`

- **Auth**: session; `owner` role.
- **Returns**: `200 { success: true }`.

### `GET /spaces/:spaceId/members`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Behavior**: email addresses are only included when the caller is the space
  creator or holds `editor`+; otherwise `email` is `undefined` per member. Includes
  direct-user permissions, group-only permission rows, and group members expanded to
  individual rows.
- **Returns**: `200` array of `{ spaceId, userId, groupId, role, joinedAt, user? }`.

### `GET /spaces/:spaceId/properties`

- **Auth**: session, access token, or public; `viewer` role.
- **Returns**: `200 { properties: PropertyInfo[] }` — all document property
  keys/types/values used across the space (for filter UIs).

### `GET /spaces/:spaceId/audit-logs`

- **Auth**: session; `verifySpaceAccess` + `verifyFeatureAccess(view_audit)`.
- **Query**: `limit`, `offset` (via `parsePaginationParams`, default 50/max 500).
- **Returns**: `200 { auditLogs, total, limit, offset }` — each log has `details`
  parsed from its raw stored form.

---

## Categories

### `GET /spaces/:spaceId/categories`

- **Auth**: any credential type, or public. Visibility is filtered: if the caller
  lacks space-level `viewer`, only categories the caller has explicit `viewer` ACL
  access to are returned (empty → `403`/`401`).
- **Returns**: `200 { categories }`. `404` if space doesn't exist.

### `POST /spaces/:spaceId/categories`

- **Auth**: session or access token; `editor` role.
- **Body**: `name` (string, required), `slug` (string, required), `description?`,
  `color?`, `icon?` (strings).
- **Returns**: `201 { category }`.

### `PUT /spaces/:spaceId/categories` (reorder)

- **Auth**: session or access token; `editor` role.
- **Body**: `{ categoryIds: string[] }` (non-empty array; new display order).
- **Returns**: `200 { success: true }`.

### `GET /spaces/:spaceId/categories/:id`

- **Auth**: session (category-or-space viewer) / access token (category viewer
  permission) / public (category public-viewer).
- **Returns**: `200 { category }`. `404` if missing.

### `PUT /spaces/:spaceId/categories/:id`

- **Auth**: session or access token; `editor` role on this category.
- **Body**: same fields as create (`name`, `slug` required; `description`, `color`,
  `icon` optional).
- **Returns**: `200 { category }`. `404` if not found.

### `DELETE /spaces/:spaceId/categories/:id`

- **Auth**: session or access token; `editor` role on this category.
- **Returns**: `200 { success: true }`.

---

## Permissions

### `GET /spaces/:spaceId/permissions`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Query**: `type` (`role` | `feature` | `all`, default `all`), `resourceType`
  (default `space`), `resourceId` (default `spaceId`).
- **Returns**: `200 { permissions: Array<{ type: "role"|"feature", permission }> }`.

### `POST /spaces/:spaceId/permissions`

- **Auth**: session. Role required varies by action:
  - granting `owner` role → caller must be `owner`
  - revoking any non-document/non-document_tree role → caller must be `owner`
  - all other role grants/revokes → caller must be `editor`
  - any `feature` operation → caller must be `owner`
- **Body**: `type` (`"role"` | `"feature"`, required), `roleOrFeature` (string,
  required — role: `viewer`/`editor`/`owner`; feature: one of `Feature` enum values),
  `userId?` or `email?` (resolved to a userId via case-insensitive exact match, 404 if
  no account) or `groupId?` (one of the three identity fields required),
  `action` (`"grant"` | `"deny"` | `"revoke"`, required), `resourceType?` (default
  `space`), `resourceId?` (default `spaceId`).
- **Returns**: `200 { permission }` (grant/deny) or `200 { success: true }` (revoke).

### `GET /spaces/:spaceId/permissions/me`

- **Auth**: session; `verifySpaceAccess`.
- **Returns**: `200 { role, features: Record<Feature, boolean>, groups }` — caller's
  effective space role, computed feature flags, and ACL groups.

---

## Search

### `GET /spaces/:spaceId/search`

- **Auth**: `authenticateSpaceAccess(viewer)`.
- **Query**: `q` (string), `limit`/`offset` (default 20/max 100), `filters` (JSON
  array string of `{ key: string, value: string|null }`).
- **Behavior**: empty query + no filters → returns empty result set without
  querying. Public-space access is treated as a trusted view (no per-document ACL
  filtering) for search purposes.
- **Returns**: `200 { results, total, query, limit, offset, filters }`. `400` for
  malformed `filters`.

### `POST /spaces/:spaceId/search/rebuild`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Returns**: `200` success message (rebuilds the space's search embeddings).

---

## Access tokens

### `GET /spaces/:spaceId/access-tokens`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200 { tokens: Array<Token & { resources }> }`.

### `POST /spaces/:spaceId/access-tokens`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Body**: `name` (non-empty string, required), `permission` (string, required —
  `viewer`/`editor`/`owner`, or the special value `"extensions"` for a space-wide
  `manage_extensions` capability grant with no resource), `resourceType`/`resourceId`
  (required unless `permission === "extensions"`; validated against
  `ResourceType`), `expiresInDays?` (positive number).
- **Behavior**: `verifyCanGrantTokenAccess` ensures the caller cannot delegate more
  authority than they hold.
- **Returns**: `201 { id, token, resources, message }` — the raw token string is only
  ever returned here.

### `GET /spaces/:spaceId/access-tokens/:tokenId`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200 { token: { ...tokenFields, resources } }`. `404` if missing.

### `PATCH /spaces/:spaceId/access-tokens/:tokenId` (revoke)

- **Auth**: session; `verifySpaceRole(owner)`.
- **Returns**: `200 { message }` (soft-delete/revoke). `404` if missing.

### `DELETE /spaces/:spaceId/access-tokens/:tokenId`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Returns**: `200 { message }` (hard delete). `404` if missing.

### `PUT /spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Body**: `{ permission: string }`. `resourceType` validated against enum;
  `verifyCanGrantTokenAccess` re-checked.
- **Returns**: `200 { resources, message }`.

### `DELETE /spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Returns**: `200 { message }`.

---

## Uploads

### `GET /spaces/:spaceId/uploads`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Returns**: `200 { files: Array<FileInfo & { url }> }`.

### `POST /spaces/:spaceId/uploads`

- **Auth**: session or access token; `editor` role.
- **Body**: multipart form — `file` (blob, required), `filename?`, `documentId?`
  (must pass `isSafeUploadIdPart`).
- **Behavior**: 1.25GB size cap per upload. Content-addressed storage key
  (`sha256[:2]/sha256.ext`). Text is extracted synchronously and stored for search;
  if `documentId` given, the parent document's embedding is re-indexed
  asynchronously.
- **Returns**: `200 { url, key }`. `400` for missing file / invalid `documentId` /
  oversize.

### `GET /spaces/:spaceId/uploads/*path`

- **Auth**: `authenticateSpaceAccess(viewer)`.
- **Query**: image/video transform params (via `parseTransformParams`, e.g. resize).
- **Behavior**: path-traversal-checked; resolves via storage adapter redirect,
  on-the-fly transform+cache, or local filesystem stream. Supports HTTP `Range`
  requests (206 partial content) for video playback. Sets a restrictive CSP,
  `nosniff`, and forces download (`Content-Disposition`) for active content types
  (svg/html) to prevent stored XSS. 1-year immutable cache.
- **Returns**: file stream, `404` if missing, `416` for unsatisfiable ranges.

### `DELETE /spaces/:spaceId/uploads/*path`

- **Auth**: session or access token; `editor` role.
- **Returns**: `204` (idempotent — removes storage object + file-table row).

---

## Secrets

Space-scoped secret values (e.g. API keys used by extensions/jobs).

### `GET /spaces/:spaceId/secrets`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200 { secrets }` — metadata only (names/description), no values.

### `POST /spaces/:spaceId/secrets`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Body**: `name` (string, required, sanitized via `sanitizeSecretName` — throws
  `400` if invalid), `value` (string, required), `description?` (string or null).
- **Returns**: `201 { secret }` (upsert — same endpoint updates existing secret with
  that name).

### `GET /spaces/:spaceId/secrets/:name`

- **Auth**: session or access token; `viewer` role.
- **Behavior**: `getSpaceSecretValueForUser` performs per-user secret-access
  filtering; if the secret exists but this user can't read it → `403`; if it doesn't
  exist at all → `404`.
- **Returns**: `200 { name, value }`.

### `PUT /spaces/:spaceId/secrets/:name`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Body**: `value` (string, required), `description?` (string or null).
- **Returns**: `200 { secret }` (upsert by name from the path, sanitized).

### `DELETE /spaces/:spaceId/secrets/:name`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Returns**: `200 { success: true }`. `404` if not found.

### `HEAD /spaces/:spaceId/secrets/:name`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200` empty body if the secret exists; `404` otherwise.

---

## Settings — AI provider

### `GET /spaces/:spaceId/settings/ai-provider`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200 { aiProvider: meta }` — metadata only (never the raw API key).

### `PUT /spaces/:spaceId/settings/ai-provider`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Body**: `provider` (required — `"ollama"` | `"anthropic"` | `"openai"` |
  `"openrouter"` | `"opencode-zen"`), `model` (non-empty string, required).
  For `ollama`: `baseUrl` (non-empty string, required; trailing slash stripped). For
  the others: `apiKey` (non-empty string, required).
- **Returns**: `200 { aiProvider: meta }`. `400` for missing/unknown provider fields.

### `DELETE /spaces/:spaceId/settings/ai-provider`

- **Auth**: session; `verifySpaceRole(owner)`.
- **Returns**: `200 { success: true }`.

---

## Integrations (OAuth)

### `GET /spaces/:spaceId/integrations`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Returns**: `200 { connections: Array<{ provider, label, configured,
  missingConfig, connected, externalAccountId, externalUsername, instanceUrl,
  scopes, accessTokenExpiresAt, createdAt, updatedAt, lastUsedAt }> }` — one entry
  per known provider, connected or not, for the calling user.

### `GET /spaces/:spaceId/integrations/:provider`

- **Auth**: session; `verifySpaceRole(viewer)`. `provider` must be a known
  `OAuthIntegrationProvider` (else `400`).
- **Returns**: `200 { connection }` (same shape as one list entry).

### `DELETE /spaces/:spaceId/integrations/:provider`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Returns**: `200 { success: true }` (disconnects this user's connection).

### `POST /spaces/:spaceId/integrations/:provider/connect`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Body**: `redirectTo?` (string, normalized to an internal path).
- **Behavior**: provider must be configured (else `400` listing missing config keys).
  Generates OAuth `state` + PKCE verifier/challenge, persists pending state.
- **Returns**: `200 { authorizeUrl }` — client redirects the browser here.

### `GET /spaces/:spaceId/integrations/:provider/callback`

- **Auth**: session; `verifySpaceRole(viewer)`. (Not JSON — a browser redirect
  target.)
- **Query**: `code`, `state` (from provider), or `error`/`error_description`.
- **Behavior**: consumes the pending OAuth state (validated per user/provider),
  exchanges the code, fetches the external account identity, upserts the
  integration credential.
- **Returns**: `302` redirect to the original `redirectTo` (or a space-root
  fallback) with query params `integration=<provider>&status=connected|error
  [&message=...]`.

### `POST /spaces/:spaceId/integrations/:provider/proxy`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Body**: `{ method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE" (default GET), path:
  string (required), headers?: Record<string,string> (only `accept`/`content-type`
  forwarded), body?: string }`.
- **Behavior**: resolves the caller's stored OAuth credential for that provider
  (must belong to the resolved user), refreshes the access token if within 60s of
  expiry, builds the target URL against the provider's configured origin (rejecting
  cross-origin `path` values; GitLab paths are pinned under `/api/v4`), forwards the
  request with a fresh `Authorization: Bearer` header.
- **Returns**: `200 { ok, status, statusText, headers (subset: content-type, link,
  x-*-page/total), body: string }` — the upstream response is always wrapped in a
  `200`, with the real upstream status reported inside the JSON.

---

## Jobs

### `POST /spaces/:spaceId/jobs/run`

- **Auth**: session or access token; `editor` role.
- **Body**: `{ jobId: string (required), inputs?: Record<string, unknown>, stream?:
  boolean }`. `jobId`s are unique within a space (no `extensionId` needed); the
  handler resolves which extension/entry owns the job.
- **Behavior**: extracts the job's extension package and runs it in a sandbox.
  Non-streaming: runs to completion inline. Streaming (`stream: true`): SSE.
- **Returns** (non-stream): `200 { outputs, logs }`.
- **Returns** (stream): `text/event-stream` of `data: { type: "log", message }` /
  `{ type: "output", outputs }` / `{ type: "error", error }`, then `data: [DONE]`.
- `400` if `jobId` missing/unknown or its extension package is missing.

### `GET /spaces/:spaceId/jobs/runs`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Query**: `jobId?`, `scheduleId?`, `limit`/`offset` (default 50/max 500).
- **Behavior**: lists all recorded job executions — manual, workflow-node, and
  cron-scheduled runs.
- **Returns**: `200 { runs, total, limit, offset }`.

---

## Workflows — runs

### `GET /spaces/:spaceId/workflows/runs`

- **Auth**: session or access token; `viewer` role. Runs are filtered to ones whose
  backing document the caller can read.
- **Query**: `documentId?` (returns just the latest run for that document, `404` if
  none/inaccessible), `sourceExtensionId?` (filter), `filterDocumentId?` (narrow list
  to one document), `limit`/`offset` (default 20/max 200, only used in list mode).
- **Returns** (with `documentId`): `200 { runId, status }`.
- **Returns** (list mode): `200 { runs: Array<{ runId, documentId, documentSlug,
  documentTitle, status, createdAt, startedAt, finishedAt, sourceExtensionId,
  runtimeInputs }>, total, limit, offset }`.

### `POST /spaces/:spaceId/workflows/runs`

- **Auth**: session or access token; `editor` role.
- **Body**: `{ documentId: string (required), inputs?: Record<string, unknown>,
  sourceExtensionId?: string }`. Target document must exist and have
  `type === "workflow"` (else `400`/`404`).
- **Behavior**: starts the run asynchronously; does not block on completion.
- **Returns**: `202 { runId }`.

### `GET /spaces/:spaceId/workflows/runs/:runId`

- **Auth**: session or access token; `viewer` role, plus a document-read ACL check.
- **Returns**: `200 { runId, documentId, status, createdAt, startedAt, completedAt,
  sourceExtensionId, runtimeInputs, error, logs, resultArtifact: {key,url}|null,
  logArtifact: {key,url}|null }`. `404` if the run doesn't exist or isn't readable.

### `POST /spaces/:spaceId/workflows/runs/:runId` and `DELETE /spaces/:spaceId/workflows/runs/:runId`

- **Auth**: session; `verifySpaceRole(editor)`. (Both methods do the same thing —
  cancel.)
- **Returns**: `200 { ok: true }`. `404` if run not found.

---

## Workflows — schedules

Cron-driven execution of `type: "workflow"` documents. Replaced the older per-job
schedule mechanism.

### `GET /spaces/:spaceId/workflows/schedules`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200 { schedules: WorkflowScheduleDto[] }`.

### `POST /spaces/:spaceId/workflows/schedules`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Body**: `documentId` (string, required — must reference an existing document of
  `type === "workflow"`), `cronExpression` (string, required — standard 5-field
  cron, validated), `timezone?` (IANA string), `inputs?` (object), `enabled?`
  (boolean).
- **Returns**: `200 { schedule }`. `400` for invalid cron, missing document, or wrong
  document type.

### `GET /spaces/:spaceId/workflows/schedules/:scheduleId`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Returns**: `200 { schedule }`. `404` if missing.

### `PATCH /spaces/:spaceId/workflows/schedules/:scheduleId`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Body**: any of `cronExpression?`, `timezone?` (string or null), `inputs?`
  (object or null), `enabled?` (boolean) — all optional, re-validates cron if
  `cronExpression`/`timezone` change.
- **Returns**: `200 { schedule }`.

### `DELETE /spaces/:spaceId/workflows/schedules/:scheduleId`

- **Auth**: session; `verifySpaceRole(editor)`.
- **Behavior**: run history for the schedule is preserved.
- **Returns**: `200 { success: true }`.

---

## AI chat sessions

Per-user, per-space saved chat session state (used by the ACP chat UI).

### `GET /spaces/:spaceId/ai-chat/sessions`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Returns**: `200 { sessions }` (caller's own sessions only).

### `GET /spaces/:spaceId/ai-chat/sessions/:sessionId`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Returns**: `200 { session }`. `404` if not found (for this user).

### `PUT /spaces/:spaceId/ai-chat/sessions/:sessionId`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Body**: full session object — `id` (must equal path param), `spaceId` (must
  equal path param), `title` (non-empty string), `createdAt`/`updatedAt` (numbers),
  `messages` (array), `conversationHistory` (array), `shellSnapshot?` (string or
  null).
- **Returns**: `200 { session }` (upsert).

### `DELETE /spaces/:spaceId/ai-chat/sessions/:sessionId`

- **Auth**: session; `verifySpaceRole(viewer)`.
- **Returns**: `200 { success: true }`. `404` if not found.

---

## Documents

### `GET /spaces/:spaceId/documents`

- **Auth**: `authenticateSpaceAccess(viewer)`.
- **Query**: `limit` (≤500, default 50), `cursor?`, `type?` (filter),
  `categorySlugs?` (comma-separated), `grouped` (`"true"` groups results by
  category), `parentId?` (list direct children of a parent instead of top-level
  listing).
- **Behavior**: content is never included in list responses (fetched separately per
  document). `record`-type documents are excluded when filtering by category.
- **Returns**: shape depends on query — `{ documentsByCategory, categorySlugs }`
  (grouped), `{ documents, total, limit, offset }` (category/flat), or
  `{ documents, total, limit, nextCursor }` (`parentId` or default cursor-paginated
  listing).

### `POST /spaces/:spaceId/documents`

- **Auth**: session or access token; `editor` role.
- **Body**: JSON (`Content-Type: application/json`) — `content` (string, required),
  `properties?` (object of property inits, e.g. `{ title, slug, ... }`),
  `parentId?`, `type?`, `slug?`, `createdAt?`/`updatedAt?` (ISO strings),
  `contentType?` (source content type, e.g. `text/markdown`, converted to HTML).
  Or raw body (any other `Content-Type`) with `X-Document-Type`,
  `X-Document-Title`, `X-Document-Slug` headers.
- **Returns**: `201 { document }`. `400` for missing content or invalid parent
  (`InvalidDocumentParentError`).

### `GET /spaces/:spaceId/documents/archived`

- **Auth**: session; `verifySpaceAccess`.
- **Query**: `limit`/`offset` (default 50/max 500).
- **Returns**: `200 { documents, total, limit, offset }`.

### `GET /spaces/:spaceId/documents/:documentId`

- **Auth**: session / access token / public, gated on `viewer` role normally, or
  `editor` when `draft=true` or `live=true` (unpublished content).
  `spaceId` path param may be either the space id or its slug; `documentId` may be
  either the doc id or its slug.
- **Query**: `rev?` (int ≥1 — fetch a specific revision instead of current content),
  `draft` (`"true"` — bypass published-revision resolution), `live` (`"true"` —
  read from the in-memory Yjs collaboration room if the doc is open).
- **Behavior**: `Accept: text/markdown` or `text/plain` returns the content
  converted to Markdown instead of JSON. Workflow-run-type documents (internal) are
  hidden (`404`). CORS headers (`Access-Control-Allow-Origin: *`) are added for
  cross-host embedding.
- **Returns**: `200 { document, space: { id, slug, name } }` (includes
  `headerImageAspectRatio`), or `200 { revision }` when `rev` given, or a
  `text/markdown` body. `404` if space/document/revision missing.

### `PUT /spaces/:spaceId/documents/:documentId`

- **Auth**: session or access token; `editor` role.
- **Query**: `publish=true` — also publish the newly created revision.
- **Body**: JSON — either `{ content: string }` (full content replacement, creates a
  revision) or `{ restore: true }` (revert to the currently-published revision;
  cannot combine with `content`). Or raw body (non-JSON content type).
- **Behavior**: readonly documents (`document.readonly` or in
  `readOnlyDocumentTypes`) always reject writes with `403`. Script tags are stripped
  from HTML-type content before saving.
- **Returns**: `200 { document }` — **`content` field is omitted** from the response
  to avoid re-serializing large payloads (client already has what it sent). `404` if
  document missing.

### `PATCH /spaces/:spaceId/documents/:documentId`

- **Auth**: session or access token; `editor` role on this document.
- **Body**: exactly one of these patch shapes (properties patch cannot combine with
  the others):
  - `properties: Record<string, PropertyPatchValue>` — each value is `null` (delete
    property), a scalar/array, or `{ value, type? }`.
  - `parentId: string | null` — move the document (verifies access to the new
    parent); broadcasts a `document_parent_changed` realtime event.
  - `publishedRev: number | null` — publish a specific revision (or unpublish with
    `null`); triggers "document published" email notifications; audit-logged.
  - `readonly: boolean` — lock/unlock the document (CSV-type docs must stay
    readonly). Audit-logged.
- **Returns**: `200 { success: true }` or `200 { slug? }` for a properties patch that
  changed the slug.

### `DELETE /spaces/:spaceId/documents/:documentId`

- **Auth**: session or access token; `editor` role on this document (`permanent=true`
  additionally requires `owner`; `editor` suffices for archive).
- **Query**: `permanent` (`"true"` — hard delete; default is soft archive).
- **Returns**: `200 { success: true }`.

### `POST /spaces/:spaceId/documents/:documentId` (create revision)

- **Auth**: session (`requireUser`) + `verifyDocumentAccess`.
- **Body**: JSON — `html` (string, required), `message?` (string), `mode?`
  (`"revision"` | `"suggestion"`, default revision). Or raw body.
- **Behavior**: readonly documents reject with `403`. `mode: "suggestion"` creates a
  pending-status suggestion revision instead of a normal one.
- **Returns**: `200 { revision: { id, documentId, rev, checksum, parentRev, status,
  message, createdAt, createdBy } }`.

### `GET /spaces/:spaceId/documents/:documentId/children`

- **Auth**: session; `verifyDocumentAccess`.
- **Returns**: `200 { children }` (ACL-filtered).

### `GET /spaces/:spaceId/documents/:documentId/breadcrumbs`

- **Auth**: session (`verifySpaceRole(viewer)`) or public
  (`verifyPublicSpaceRole(viewer)`).
- **Returns**: `200 { breadcrumbs }` — ancestor chain for the document.

### `GET /spaces/:spaceId/documents/:documentId/contributors`

- **Auth**: session; `verifyDocumentAccess`.
- **Behavior**: derived from audit log events matching
  `DOCUMENT_CONTRIBUTION_AUDIT_EVENTS`, deduplicated by user.
- **Returns**: `200 { contributors: Array<{ id, name, email, image }> }`.

### `GET /spaces/:spaceId/documents/:documentId/comments`

- **Auth**: `verifyDocumentAccess` (allows public docs; `user` optional).
- **Returns**: `200 { comments }` — each enriched with `createdByUser: {id, name,
  email, image} | null`.

### `POST /spaces/:spaceId/documents/:documentId/comments`

- **Auth**: session; `verifyDocumentAccess` + `verifyFeatureAccess(comment)`.
- **Body**: `content` (string, required), `parentId?` (string), `type?` (string),
  `reference?` (string — required for top-level/non-reply comments).
- **Behavior**: audit-logged; enqueues "comment created" email notifications;
  broadcasts a `comment_created` realtime event.
- **Returns**: `200 { comment }`.

### `PATCH /spaces/:spaceId/documents/:documentId/comments`

- **Auth**: session; `verifyDocumentAccess` + `verifyFeatureAccess(comment)`.
- **Body**: `commentIds: string[]` (required, non-empty, filtered to ones on this
  document), and either `archived: true` (archive them; broadcasts
  `comment_deleted`) or `reference: string` (re-point them; broadcasts
  `comment_updated`).
- **Returns**: `200 { success: true }`. `404` if none of the ids belong to the doc.

### `DELETE /spaces/:spaceId/documents/:documentId/comments`

- **Auth**: session; `verifyDocumentAccess`. Caller must be the comment's creator
  (else `403`).
- **Body**: `{ commentId: string }`.
- **Behavior**: broadcasts `comment_deleted`.
- **Returns**: `200 { success: true }`. `404` if comment missing.

### `GET /spaces/:spaceId/documents/:documentId/diff`

- **Auth**: `authenticateRequest` (session or access token); `verifyDocumentRole`/
  `verifyTokenPermission(viewer)`.
- **Query**: `rev` (int ≥1, required), `format` (`"html"` for an inline `<ins>`/
  `<del>` redline; default a unified diff patch via the `diff` package).
- **Behavior**: diffs the given revision against its comparison base (parent
  revision for suggestions, else the document's currently published revision).
- **Returns**: `200` `text/plain` unified patch, or `text/plain` inline HTML redline.
  `400` if no comparable base revision/content exists.

### `POST /spaces/:spaceId/documents/:documentId/edit`

- **Auth**: session or access token; `editor` role on this document.
- **Body**: `{ operations: <edit-operation spec> }` — parsed/validated by
  `parseEditOperations`.
- **Behavior**: readonly documents always reject with `403`. Applies the operations
  to the live collaboration document (Yjs room) if open, so it merges with
  concurrent edits instead of overwriting; falls back to the stored content
  otherwise. Script tags stripped from the result.
- **Returns**: `200 { document, live: boolean }` (`live` indicates whether the edit
  was applied to an open collab room). `400` for invalid operations.

### `GET /spaces/:spaceId/documents/:documentId/email-preference`

- **Auth**: session; `verifyDocumentAccess`.
- **Returns**: `200 { muted: boolean }` — per-user email-notification mute state for
  this document.

### `PATCH /spaces/:spaceId/documents/:documentId/email-preference`

- **Auth**: session; `verifyDocumentAccess`.
- **Body**: `{ muted: boolean }`.
- **Returns**: `200 { muted }`.

### `GET /spaces/:spaceId/documents/:documentId/audit-logs`

- **Auth**: session; `verifyDocumentAccess` + `verifyFeatureAccess(view_audit)`.
- **Query**: `limit`/`offset` (default 50/max 500).
- **Returns**: `200 { auditLogs, total, limit, offset }`.

### `GET /spaces/:spaceId/documents/:documentId/revisions`

- **Auth**: session; `verifyDocumentAccess` + `verifyFeatureAccess(view_history)`.
- **Returns**: `200 { revisions }` (metadata list, no content bodies).

### `POST /spaces/:spaceId/documents/:documentId/revisions` (restore)

- **Auth**: session; `verifyDocumentRole(editor)`.
- **Query**: `rev` (int ≥1, required).
- **Body**: `{ message?: string }` (optional).
- **Returns**: `200 { revision }` — restores the given revision as a new current
  revision.

### `PATCH /spaces/:spaceId/documents/:documentId/revisions` (suggestion status)

- **Auth**: session; `verifyDocumentRole(editor)`.
- **Query**: `rev` (int ≥1, required).
- **Body**: `{ status: "open" | "applied" | "dismissed" }`. The target revision must
  be a suggestion (non-null `status`) — else `400`.
- **Returns**: `200 { revision }`. `404` if revision missing.

---

## Extensions

### `GET /spaces/:spaceId/extensions`

- **Auth**: session or access token; `editor` role. Only extensions the caller can
  access are returned (`canAccessExtension` — editor-on-space or explicit extension
  ACL).
- **Returns**: `200 { extensions: Array<{ id, name, version, description, enabled,
  source, sourceRef, sourcePublisher, entries, routes, jobs, createdAt, updatedAt,
  createdBy }>, errors: manifestErrors }`.

### `POST /spaces/:spaceId/extensions` (install/update)

- **Auth**: session or access token holding the `manage_extensions` feature
  (`verifyFeatureAccess`/`verifyTokenFeature`).
- **Body**: multipart form — `file` (a `.zip`, ≤5MB, required; must contain
  `manifest.json`).
- **Behavior**: extension id comes from the manifest (`manifest.id`); if it already
  exists in the space, the upload updates it in place instead of creating a new one.
  The server-wide extension-source policy must allow `"upload"` (else `403`).
- **Returns**: `201` extension metadata (same shape as the list entries). `400` for
  invalid zip/manifest or oversize file; `403` if uploads are disabled by policy.

### `GET /spaces/:spaceId/extensions/:extensionId`

- **Auth**: session or access token; `editor` role, plus `verifyExtensionAccess`.
- **Returns**: `200` extension metadata object. `404` if missing.

### `PATCH /spaces/:spaceId/extensions/:extensionId` (enable/disable)

- **Auth**: session; `verifyFeatureAccess(manage_extensions)`.
- **Body**: `{ enabled: boolean }`.
- **Returns**: `200` updated extension metadata. `400` if `enabled` isn't boolean;
  `404` if missing.

### `DELETE /spaces/:spaceId/extensions/:extensionId`

- **Auth**: session; `verifyFeatureAccess(manage_extensions)`.
- **Returns**: `200 { success: true }`. `404` if missing.

### `GET /spaces/:spaceId/extensions/:extensionId/package`

- **Auth**: session; `verifyFeatureAccess(manage_extensions)`.
- **Behavior**: downloads the raw extension ZIP — for debugging broken packages.
- **Returns**: `200` `application/zip` binary with a `Content-Disposition`
  attachment header. `404` if missing.

### `GET /spaces/:spaceId/extensions/:extensionId/assets/*path`

- **Auth**: session; `verifyExtensionAccess`.
- **Behavior**: extracts the requested file on-demand from the stored extension
  ZIP. `.js`/`.mjs`/`.css` responses omit CSP entirely (a CSP header on a module
  script response hangs Chrome's `import()`); other asset types get a restrictive
  asset CSP. 1-hour cache.
- **Returns**: `200` file bytes with a MIME type inferred from extension. `404` if
  extension/asset missing.
