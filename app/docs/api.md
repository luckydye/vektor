# Vektor API

JSON over HTTP for documents, categories, uploads, comments, search, workflows,
extensions and space settings.

## Quick start

You need an access token and the id of the space you are working in.

A space owner creates a token with `POST /spaces/:spaceId/access-tokens`. The raw string
is returned on that response only and cannot be retrieved afterwards. `vektor login`
performs the same exchange through the browser and stores the token and space in
`~/.config/vektor/config.json`.

```bash
export VEKTOR="https://vektor.example.com/api/v1"
export TOKEN="at_9f1cb37a0d5e48c2b6a71f8043e29dbc5471aa9e2c60d8f31b74e05ca6d92f8b1"
export SPACE="space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240"
```

List the spaces the token can reach:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces"
```

```json
[
  {
    "id": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
    "name": "Acme",
    "slug": "acme",
    "userRole": "editor"
  }
]
```

Create a document in it from Markdown:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "content": "# Launch plan\n\nShip on the 21st.",
        "contentType": "text/markdown",
        "properties": { "title": "Launch plan" }
      }' \
  "$VEKTOR/spaces/$SPACE/documents"
```

```json
{
  "document": {
    "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "slug": "launch-plan",
    "content": "<h1>Launch plan</h1><p>Ship on the 21st.</p>",
    "currentRev": 0,
    "publishedRev": null
  }
}
```

## Conventions

Each endpoint below lists the credentials and role it requires, its parameters and what it
returns, followed by an example request and response.

- Paths use named parameters — `/spaces/:spaceId/documents/:documentId`. A `*path`
  segment matches everything after it.
- Response examples are trimmed: arrays cut to one element, long strings elided. Every
  field an endpoint's description names appears in its example at least once.
- Timestamps are ISO 8601 strings. Ids are prefixed with their type — `space_`, `doc_`,
  `rev_`, `token_`, `run_`, `sched_`, `category_`, `comment_`.
- Some endpoints accept only a session cookie, as their **Auth** line states. To call one
  with curl, copy the cookie from a logged-in browser:
  `export COOKIE="vektor.session_token=…"`.

## Authentication

Five kinds of credential reach this API. Each endpoint's **Auth** line lists the ones it
accepts.

| Credential | Sent as | Used by |
|---|---|---|
| Session cookie | `vektor.session_token` cookie | the app in a browser |
| Access token | `Authorization: Bearer at_…` | integrations, CI, scripts, the CLI |
| Job token | `X-Job-Token` | extension jobs, workflow runs, the AI agent calling back in |
| Share link | `vektor.share_links` cookie | a visitor reading a page opened from a `/s/:linkId` link |
| None | — | readers of a resource shared with the `public` group |

A credential is an identity of its own in the ACL, named by its id — `token_…` for an
access token, `share_…` for a share link — so it holds grants rather than borrowing an
account's. Neither can be issued with more access than the person issuing it holds.

Job tokens are minted by the server rather than by clients: one carrying a user id is
limited to what that user may do, and one without a user id is a background credential,
valid only inside its own space.

A share link is resolved from its cookie on document-scoped routes, which is what makes a
shared page's own requests — its attachments above all — ordinary authenticated ones. It
is consulted only after a session and a token, so it never downgrades a caller who is
already someone, and it is re-read per request, so revoking a link takes effect at once.
See [Share links](#share-links) for minting and revoking them.

## Authorization

Access is a role on a resource. Roles are a ladder — `viewer` < `editor` < `owner` — and
can be granted on a space, a category, a document, or a document tree (a page and
everything filed under it). Grants name one of these resource types: `space`, `document`,
`document_tree`, `category`, `extension`, `feature`.

Four capabilities are granted separately from roles, per user or group: `comment`,
`view_history`, `view_audit` and `manage_extensions`. Each role has defaults — owner holds
all four, editor all but `manage_extensions`, viewer none — and a **feature** can also be
denied explicitly.

[Permissions](/docs/permissions) documents the full model. Two of its rules affect many
endpoints below:

- **A resource-scoped grant carries no space-wide role.** A caller shared into a single
  document, document tree or category is still admitted by endpoints that list documents,
  or things belonging to documents such as uploads, which filter results to what those
  grants reach. Endpoints returning space-wide collections that cannot be filtered per
  document — members, integrations, audit logs — require a role on the space.
- **Archived documents require `editor`.** While a document is archived, viewer grants and
  public links stop resolving without being revoked; restoring the document makes them
  work again.

## Responses and errors

Successful responses are JSON, usually wrapped in a key naming the payload:
`{ document }`, `{ space }`, `{ categories }`. Errors use a single shape, with the status
code carrying the meaning:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/secrets"
```

```json
{ "error": "Forbidden" }
```

| Code | Meaning |
|---|---|
| `400` | missing or invalid parameter or body |
| `401` | no credential, or one that could not be validated |
| `403` | authenticated, but the required role or feature is missing |
| `404` | no such resource, and the response for a path matching no route |
| `405` | method not allowed; the `Allow` header lists the supported methods |
| `429` | rate limited; `Retry-After` gives the seconds to wait |
| `500` | internal server error |
| `502` | an upstream the server proxies to (an AI provider) refused or was unreachable |
| `503` | no hosted space database available; only space creation returns this |

Browser clients also pass a CSRF check: a request with an unsafe method whose `Origin` is
neither a configured trusted origin nor this host is rejected with `403 Cross-origin
request rejected` before routing, in addition to the SameSite cookie default. Requests
without an `Origin` header — curl, access tokens, CalDAV clients — are unaffected.

## Rate limits

Every response carries `X-Limit-Remaining`, the number of requests left in the caller's
current window:

```bash
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Limit-Remaining: 597
```

Exceeding the window returns `429` with `Retry-After` in seconds; clients should wait that
long before retrying. Requests are counted **per access token** when one is presented and
**per IP** otherwise, so an integration has its own budget while browser sessions share
the instance's per-IP budget. The token is hashed to form the key and is never stored or
logged.

Ordinary routes share one bucket — 600 requests per minute by default, configurable with
`VEKTOR_RATE_LIMIT_MAX` and `VEKTOR_RATE_LIMIT_WINDOW`. Routes that do more work per call
have tighter limits that those settings cannot raise:

| Route | Limit |
|---|---|
| `POST /spaces/:spaceId/search/rebuild` | 5/hour |
| `POST /chat/completions`, `POST /chat/acp` | 30/min |
| `POST /spaces/:spaceId/jobs/run` | 30/min |
| `POST /spaces/:spaceId/workflows/runs` | 30/min |
| `GET /spaces/:spaceId/uploads/*path` | 300/min |

Windows are held in memory per process, so a restart clears outstanding ones: this is
load-shedding rather than quota accounting. `VEKTOR_RATE_LIMIT=0` disables it entirely,
and `VEKTOR_RATE_LIMIT_BLOCK` rejects named keys outright. The keys it accepts are the
ones printed in the `API rate limit exceeded` log line.

## Endpoint index

Every path below is mounted under `/api/v1`. Session auth itself
(`/api/auth/[...all]`, better-auth) and CalDAV (`/api/caldav/...`, `/.well-known/caldav`,
`/.well-known/vektor`) are served alongside this API and are out of scope here; the CLI
login endpoints under `/api/v1/auth/cli` are documented. Internally each route is one file
registered in `src/api/routes.ts`, exporting one function per HTTP method.

| Method | Path | What it does |
|---|---|---|
| POST | `/chat/acp` | Agent Control Protocol JSON-RPC endpoint (streaming AI chat turns) |
| POST | `/chat/completions` | OpenAI/Anthropic/Ollama-compatible chat completions proxy |
| GET/POST | `/auth/cli` | CLI login approval page / approve and mint a one-time code |
| POST | `/auth/cli/token` | Exchange that code for a space access token |
| GET | `/users` | Minimal public profile lookup (`?id=` or `?spaceId=`) |
| GET | `/users/me` | Current user profile |
| GET | `/users/suggestions` | People the caller may invite (shared OAuth groups) |
| GET/POST | `/spaces` | List spaces / create a space |
| GET/PATCH/DELETE | `/spaces/:spaceId` | Read / update / delete a space |
| GET | `/spaces/:spaceId/members` | List space members with roles |
| GET | `/spaces/:spaceId/properties` | List all document property keys/values in space |
| GET | `/spaces/:spaceId/audit-logs` | Space-wide (or `?documentId=` scoped) audit log (paginated) |
| GET/POST/PATCH/DELETE | `/spaces/:spaceId/comments` | List / create / update / delete comments (`documentId` scoped) |
| GET/PATCH | `/spaces/:spaceId/notification-preference` | Read / set per-user notification mute, space-wide or per document |
| GET/POST/PUT | `/spaces/:spaceId/categories` | List / create / reorder categories |
| GET/PUT/DELETE | `/spaces/:spaceId/categories/:id` | Read / update / delete a category |
| GET/POST | `/spaces/:spaceId/permissions` | List / grant-revoke roles, grant-deny-revoke features |
| GET | `/spaces/:spaceId/permissions/me` | Caller's role + feature flags in this space |
| GET | `/spaces/:spaceId/search` | Full-text/semantic document search |
| POST | `/spaces/:spaceId/search/rebuild` | Rebuild the space's search embeddings |
| GET/POST | `/spaces/:spaceId/share-links` | List / create share links |
| DELETE | `/spaces/:spaceId/share-links/:linkId` | Revoke a share link |
| GET/POST | `/spaces/:spaceId/access-tokens` | List / create access tokens |
| GET/PATCH/DELETE | `/spaces/:spaceId/access-tokens/:tokenId` | Read / revoke / delete a token |
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
| GET/POST | `/spaces/:spaceId/workflows/runs` | Get/list workflow runs / start (or resume) a workflow run |
| GET/POST/DELETE | `/spaces/:spaceId/workflows/runs/:runId` | Read a run / cancel it (POST or DELETE) |
| GET/POST | `/spaces/:spaceId/workflows/schedules` | List / create cron schedules for workflow documents |
| GET/PATCH/DELETE | `/spaces/:spaceId/workflows/schedules/:scheduleId` | Read / update / delete a workflow schedule |
| GET | `/spaces/:spaceId/ai-chat/sessions` | List the caller's AI chat sessions |
| GET/PUT/DELETE | `/spaces/:spaceId/ai-chat/sessions/:sessionId` | Read / save / delete an AI chat session |
| GET/POST | `/spaces/:spaceId/documents` | List documents (with filters) / create a document |
| GET | `/spaces/:spaceId/documents/archived` | List archived (soft-deleted) documents |
| GET/PUT/PATCH/DELETE/POST | `/spaces/:spaceId/documents/:documentId` | Read / replace content / patch metadata / archive-delete / create revision |
| GET | `/spaces/:spaceId/documents/:documentId/access` | Everyone who can reach the document, and the grant that gets them there |
| GET | `/spaces/:spaceId/documents/:documentId/children` | List direct child documents |
| GET | `/spaces/:spaceId/documents/:documentId/breadcrumbs` | Ancestor chain for a document |
| GET | `/spaces/:spaceId/documents/:documentId/contributors` | Users who have edited the document |
| GET | `/spaces/:spaceId/documents/:documentId/diff` | Unified/inline diff between a revision and its base |
| POST | `/spaces/:spaceId/documents/:documentId/edit` | Apply structured partial edit operations (live-merge aware) |
| GET/POST/PATCH | `/spaces/:spaceId/documents/:documentId/revisions` | List revisions / restore a revision / update suggestion status |
| GET/POST | `/spaces/:spaceId/extensions` | List extensions / upload (install or update) an extension package |
| GET/PATCH/DELETE | `/spaces/:spaceId/extensions/:extensionId` | Read / enable-disable / delete an extension |
| GET | `/spaces/:spaceId/extensions/:extensionId/package` | Download the raw extension ZIP |
| GET | `/spaces/:spaceId/extensions/:extensionId/assets/*path` | Serve a static asset from the extension package |

## Chat

### `POST /chat/acp`

Agent Control Protocol JSON-RPC 2.0 endpoint driving the in-app AI chat agent.

- **Auth**: session, access token or job token, authenticated as viewer-or-above on the
  space named in `params.spaceId`. A job-to-job call presents `X-Job-Token` plus
  `X-Space-Id`, which must match `params.spaceId` (else `400`); otherwise the server
  mints a job token for the caller's identity.
- **Body**: `{ jsonrpc: "2.0", id?, method, params }`. Supported `method`s:
  - `session/prompt` — params: `sessionId` (string, required), `spaceId` (string,
    required), `documentId?` (string), `additionalContext?` (string), `prompt`
    (non-empty array whose first element has a `text: string` field),
    `imageAttachments?` (array of `{ key, mediaType }` naming uploads in this space;
    jpeg/png/gif/webp, ≤20MB each), `attachments?` (array of
    `{ key, name, type, size }` for non-image files), `messages?` (conversation
    history, honoured only for a user-less job token). Starts or reattaches to a live
    agent turn keyed by `spaceId:userId:chatId`; the turn survives client disconnects.
    For a caller with a user identity, conversation history, user profile and connected
    OAuth providers are loaded from the DB and the user message is pre-saved before the
    agent starts.
  - `session/cancel` — params: `sessionId`, `spaceId` (both required). Aborts the
    in-progress turn for that key.
- Any other `method` → `400`.
- **Returns** (`session/prompt`): `text/event-stream` — replays buffered
  `session/update` notifications then streams new ones (`agent_message_chunk`,
  `generic` (`thinking`), `plan`, `tool_call`, `tool_call_update`), ending with a final
  JSON-RPC `result: { stopReason: "end_turn" }` or `error`, then `data: [DONE]`.
- **Returns** (`session/cancel`): `200 { jsonrpc, id, result: { cancelled: true } }`.

```bash
curl -sS -N -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "jsonrpc": "2.0",
        "id": 1,
        "method": "session/prompt",
        "params": {
          "sessionId": "chat_2026-08-17-1",
          "spaceId": "'"$SPACE"'",
          "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
          "prompt": [{ "text": "Summarise this document in three bullets." }]
        }
      }' \
  "$VEKTOR/chat/acp"
```

```text
data: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"chat_2026-08-17-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"- Ships"}}}}

data: {"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}

data: [DONE]
```

### `POST /chat/completions`

- **Auth**: session, access token or job token; `viewer` on the space named by
  `X-Space-Id`. The header is client-supplied, so the role check is what stops a
  logged-in user from spending another space's provider credentials.
- **Headers**: `X-Space-Id` (required).
- **Body**: passthrough OpenAI-style chat completion request; the server injects
  `model` for OpenAI-compatible providers.
- **Behavior**: looks up the space's configured AI provider
  (`anthropic`/`ollama`/OpenAI-compatible) and proxies the request, streaming the
  upstream response back verbatim (SSE or JSON depending on upstream). Logs (but does
  not alter) upstream error bodies.
- **Returns**: proxied upstream status/body; `Content-Type` preserved (default
  `application/json`), `Cache-Control: no-cache`. `502` when the configured base URL is
  refused by the SSRF policy.

```bash
curl -sS -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -H "X-Space-Id: $SPACE" \
  -d '{ "messages": [{ "role": "user", "content": "Say hi" }], "stream": false }' \
  "$VEKTOR/chat/completions"
```

```json
{
  "id": "chatcmpl_7Nn2",
  "object": "chat.completion",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hi." }, "finish_reason": "stop" }
  ]
}
```

## CLI login

Browser-approved login for the `vektor` CLI: the CLI opens `GET /auth/cli` on a
localhost callback, the user picks a space, and the resulting one-time code is exchanged
for an access token.

### `GET /auth/cli`

- **Auth**: session (`requireUser`).
- **Query**: `redirect_uri` (must be `http://localhost:<port>/callback` or the
  `127.0.0.1` equivalent), `state` (≥16 characters, echoed back to the CLI).
- **Behavior**: lists the spaces the user holds a space-wide role on — a
  resource-scoped grant delegates nothing, so those spaces are excluded — and renders
  an approval page carrying a single-use `approval` value (5-minute TTL). A user with
  no eligible space is redirected back to the CLI with `error=no_spaces` or
  `error=no_space_roles`.
- **Returns**: `text/html` approval page, or a `302` back to the CLI callback.

```bash
open "$VEKTOR/auth/cli?redirect_uri=http://localhost:7317/callback&state=$(openssl rand -hex 16)"
```

### `POST /auth/cli`

- **Auth**: session (`requireUser`).
- **Body**: form fields `redirect_uri`, `state`, `approval`, `spaceId`, and
  `intent=cancel` to decline.
- **Behavior**: re-validates the approval against the same user, `redirect_uri` and
  `state`, then mints a one-time code (60-second TTL) for the selected space.
- **Returns**: `text/html` page that redirects to
  `<redirect_uri>?state=…&code=…&space=…` (or `?error=access_denied` on cancel).
  `400` on an expired approval or a space the user may not delegate.

### `POST /auth/cli/token`

- **Auth**: none — the code is the proof of authentication.
- **Body**: `{ code: string }`.
- **Behavior**: single-use, expires 60 seconds after issuance. The role is resolved at
  exchange time rather than at approval, so a role revoked in between is honoured; the
  token is a `space`-scoped access token valid for 30 days.
- **Returns**: `200 { token, spaceId, permission, expiresAt }`. `400` for an invalid,
  expired or already-used code; `403` if the user no longer holds a space-wide role.

```bash
curl -sS -H "Content-Type: application/json" \
  -d '{ "code": "b1f0…" }' \
  "$VEKTOR/auth/cli/token"
```

```json
{
  "token": "at_9f1cb37a0d5e48c2b6a71f8043e29dbc5471aa9e2c60d8f31b74e05ca6d92f8b1",
  "spaceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
  "permission": "editor",
  "expiresAt": "2026-09-16T08:41:02.000Z"
}
```

## Users

### `GET /users`

- **Auth**: session (`requireUser`).
- **Query**: exactly one of `id` (single user) or `spaceId` (space members). Neither
  → `400`. A bare listing of all users is intentionally not supported.
- **Behavior (`id`)**: returns `{ id, name, image }` for that user, `404` if none.
- **Behavior (`spaceId`)**: `viewer` on the space, returns an array of
  `{ id, name, image }` for all space members (ACL member ids + the caller).
- Email is never included (PII); `image` is the provider's picture, a derived Gravatar
  URL when one is configured, or `null` for a client-drawn avatar.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/users?spaceId=$SPACE"
```

```json
[
  { "id": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0", "name": "Ada Lovelace", "image": null }
]
```

### `GET /users/me`

- **Auth**: session (`requireUser`).
- **Returns**: `200 { id, name, email, image, canCreateSpace, adminGroups }` —
  `canCreateSpace` is the instance-level gate (`VEKTOR_SPACE_CREATION_GROUPS`), which no
  space-scoped `permissions/me` can carry. `adminGroups` lists the caller's own
  `VEKTOR_ADMIN_GROUPS` memberships — empty unless they administer the instance — and is
  what the client names when it grants itself standing access to a space.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/users/me"
```

```json
{
  "id": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
  "name": "Ada Lovelace",
  "email": "ada@acme.test",
  "image": null,
  "canCreateSpace": true
}
```

### `GET /users/suggestions`

- **Auth**: session (`requireUser`).
- **Query**: `q?` — case-insensitive substring of name or email.
- **Behavior**: everyone who shares at least one OAuth group with the caller, capped at
  20. There is no global directory: a caller with no OAuth groups gets `[]`.
- **Returns**: `200` array of `{ id, name, email, image }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/users/suggestions?q=grace"
```

```json
[
  {
    "id": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE",
    "name": "Grace Hopper",
    "email": "grace@acme.test",
    "image": null
  }
]
```

## Spaces

### `GET /spaces`

- **Auth**: any of access token / session / unauthenticated.
- **Behavior**: if a bearer access token is present, returns the single space it's
  scoped to (or `[]`); else if a session exists, returns all spaces the user belongs
  to (`listUserSpaces`) — every space on the instance, as `owner`, for a member of
  `VEKTOR_ADMIN_GROUPS`; else returns spaces with `public` viewer access.
- **Returns**: `200` array of space objects.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces"
```

```json
[
  {
    "id": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
    "name": "Acme",
    "slug": "acme",
    "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
    "preferences": { "brandColor": "#9949b6", "description": "Everything Acme." },
    "createdAt": "2026-02-11T10:04:18.000Z",
    "updatedAt": "2026-08-16T14:22:51.000Z",
    "userRole": "editor"
  }
]
```

### `POST /spaces`

- **Auth**: session (`requireUser`), plus the instance's space-creation gate — `403`
  when `VEKTOR_SPACE_CREATION_GROUPS` is set and the caller is in none of them, unless
  they are an instance admin (`VEKTOR_ADMIN_GROUPS`).
- **Body**: `name` (string, required), `slug` (string, required), `preferences?`
  (object, ≤512KB serialized — see the preferences rules under `PATCH`).
- **Returns**: `201 { space }`, where `space` also carries `userRole` and the creator's
  own `userPreferences`. `400` for a missing field, an invalid or taken slug; `503` if
  no hosted database is available.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "name": "Acme", "slug": "acme", "preferences": { "brandColor": "#9949b6" } }' \
  "$VEKTOR/spaces"
```

```json
{
  "space": {
    "id": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
    "name": "Acme",
    "slug": "acme",
    "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
    "preferences": { "brandColor": "#9949b6" },
    "createdAt": "2026-02-11T10:04:18.000Z",
    "updatedAt": "2026-02-11T10:04:18.000Z",
    "userRole": "owner",
    "userPreferences": {}
  }
}
```

### `GET /spaces/:spaceId`

- **Auth**: session; `viewer` on the space, or any resource-scoped grant inside it —
  a caller shared into one document still has to read the space it lives in.
- **Returns**: `200` space object plus `userRole` and the caller's `userPreferences`
  (or a `null` body if the space was deleted mid-request).

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE"
```

```json
{
  "id": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
  "name": "Acme",
  "slug": "acme",
  "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
  "preferences": { "brandColor": "#9949b6" },
  "createdAt": "2026-02-11T10:04:18.000Z",
  "updatedAt": "2026-08-16T14:22:51.000Z",
  "userRole": "owner",
  "userPreferences": { "user:sidebar_collapsed": "true" }
}
```

### `PATCH /spaces/:spaceId`

- **Auth**: session. `name`/`slug` take `owner`. A preferences-only write takes the
  strongest role its keys ask for: `owner` for the `ai:` namespace and for
  `workflowCreationEnabled`, `viewer` for the `user:` namespace (a member's own
  settings), `editor` for everything else.
- **Body**: at least one of `name` (non-empty string), `slug` (non-empty string),
  `preferences` (object, ≤512KB serialized). A preference key is either a bare name or
  `namespace:name`; values are opaque text except for the keys the app renders as
  markup, CSS or a URL (`brandColor`, `description`, `logoSvg`, `pinnedDocumentId`,
  `workflowCreationEnabled`), which are validated and may be stored sanitized. An empty
  string clears a preference.
- **Behavior**: `user:`-namespaced preferences are stored against the caller rather than
  the space, and a write of nothing else leaves the space row (and its `updatedAt`)
  untouched.
- **Returns**: `200` updated space object with `userRole` and `userPreferences`. `400`
  if none of the three fields is given, on an invalid type or preference value, or on a
  slug collision.

```bash
curl -sS -X PATCH -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "preferences": { "description": "Everything Acme.", "user:sidebar_collapsed": "true" } }' \
  "$VEKTOR/spaces/$SPACE"
```

```json
{
  "id": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
  "name": "Acme",
  "slug": "acme",
  "preferences": { "brandColor": "#9949b6", "description": "Everything Acme." },
  "updatedAt": "2026-08-17T08:15:44.000Z",
  "userRole": "owner",
  "userPreferences": { "user:sidebar_collapsed": "true" }
}
```

### `DELETE /spaces/:spaceId`

- **Auth**: session; `owner` role, which a member of `VEKTOR_ADMIN_GROUPS` holds on
  every space.
- **Returns**: `200 { success: true }`.

```bash
curl -sS -X DELETE -b "$COOKIE" "$VEKTOR/spaces/$SPACE"
```

```json
{ "success": true }
```

### `GET /spaces/:spaceId/members`

- **Auth**: session; `viewer` on the space.
- **Behavior**: email addresses are included only for callers holding `editor`+;
  otherwise `email` is `undefined` per member. Includes direct-user permissions,
  group-only permission rows, and group members expanded to individual rows.
  Resource-scoped-only grantees are listed with an empty `role`, purely so their
  name/avatar resolves wherever a user id has to be rendered. Access tokens hold ACL
  rows but are not members, and are excluded.
- **Returns**: `200` array of `{ spaceId, userId, groupId, role, joinedAt, user? }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/members"
```

```json
[
  {
    "spaceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
    "userId": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
    "role": "owner",
    "joinedAt": "2026-02-11T10:04:18.000Z",
    "user": {
      "id": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
      "name": "Ada Lovelace",
      "email": "ada@acme.test",
      "image": null
    }
  },
  {
    "spaceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
    "groupId": "engineering",
    "role": "editor",
    "joinedAt": "2026-03-02T09:00:00.000Z"
  }
]
```

### `GET /spaces/:spaceId/properties`

- **Auth**: session, access token, job token, or public; `viewer` role.
- **Returns**: `200 { properties }` — every document property key, its type and the
  values in use across the space, for filter UIs.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/properties"
```

```json
{
  "properties": [
    { "name": "type", "type": "select", "values": ["canvas", "document", "file", "workflow"] },
    { "name": "status", "type": "select", "values": ["draft", "shipped"] }
  ]
}
```

### `GET /spaces/:spaceId/audit-logs`

- **Auth**: session; `viewer` on the space (or, when `documentId` is given, on that
  document) plus the `view_audit` feature. A trail outlives its document, so a
  `documentId` that no longer exists falls back to the space role rather than 404ing.
- **Query**: `documentId?` (scopes the log to a single document instead of the
  whole space), `limit`, `cursor?` (default 50/max 500).
- **Returns**: `200 { auditLogs, limit, nextCursor }` — each log has `details`
  parsed from its raw stored form.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/audit-logs?limit=1"
```

```json
{
  "auditLogs": [
    {
      "id": 4821,
      "docId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "revisionId": 12,
      "userId": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
      "event": "publish",
      "details": { "message": "Published revision 12" },
      "createdAt": "2026-08-17T08:20:00.000Z"
    }
  ],
  "limit": 1,
  "nextCursor": "eyJ0IjoxNzU1NDI4NDAwMDAwLCJpZCI6NDgyMX0"
}
```

## Categories

### `GET /spaces/:spaceId/categories`

- **Auth**: any credential type, or public. A caller without space-level `viewer` is
  admitted on category grants alone and sees only the categories those reach; one with
  neither gets `401`/`403`.
- **Returns**: `200 { categories, hasHiddenCategories }` — the flag tells "this space
  has no categories" apart from "none are visible to you". `404` if the space doesn't
  exist.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/categories"
```

```json
{
  "categories": [
    {
      "id": "category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83",
      "name": "Handbook",
      "slug": "handbook",
      "description": "How we work.",
      "color": "#4ecdc4",
      "icon": "book",
      "order": 0,
      "createdAt": "2026-02-12T11:00:00.000Z",
      "updatedAt": "2026-02-12T11:00:00.000Z"
    }
  ],
  "hasHiddenCategories": false
}
```

### `POST /spaces/:spaceId/categories`

- **Auth**: session, access token or job token; `editor` role.
- **Body**: `name` (string, required), `slug` (string, required), `description?`,
  `color?` (hex, e.g. `#4ecdc4` — it is rendered into a style attribute), `icon?`.
- **Returns**: `201 { category }`; `400` for a non-hex colour or a slug another
  category already uses.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "Handbook", "slug": "handbook", "color": "#4ecdc4", "icon": "book" }' \
  "$VEKTOR/spaces/$SPACE/categories"
```

```json
{
  "category": {
    "id": "category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83",
    "name": "Handbook",
    "slug": "handbook",
    "description": null,
    "color": "#4ecdc4",
    "icon": "book",
    "order": 0,
    "createdAt": "2026-02-12T11:00:00.000Z",
    "updatedAt": "2026-02-12T11:00:00.000Z"
  }
}
```

### `PUT /spaces/:spaceId/categories`

Reorders categories.

- **Auth**: session, access token or job token; `editor` role.
- **Body**: `{ categoryIds: string[] }` (non-empty array; new display order).
- **Returns**: `200 { success: true }`.

```bash
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "categoryIds": ["category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83", "category_7bd42e90-1c65-4a38-9f02-8e6b3d5714ca"] }' \
  "$VEKTOR/spaces/$SPACE/categories"
```

```json
{ "success": true }
```

### `GET /spaces/:spaceId/categories/:id`

- **Auth**: session / access token / job token / public, resolved as `viewer` on this
  category.
- **Returns**: `200 { category }`. `404` if missing.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/categories/category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83"
```

```json
{
  "category": {
    "id": "category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83",
    "name": "Handbook",
    "slug": "handbook",
    "color": "#4ecdc4",
    "order": 0
  }
}
```

### `PUT /spaces/:spaceId/categories/:id`

- **Auth**: session, access token or job token; `editor` on this category.
- **Body**: same fields as create (`name`, `slug` required; `description`, `color`,
  `icon` optional).
- **Returns**: `200 { category }`; `400` for a non-hex colour or a taken slug. `404` if
  not found.

```bash
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "Handbook", "slug": "handbook", "description": "How we work.", "color": "#9949b6" }' \
  "$VEKTOR/spaces/$SPACE/categories/category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83"
```

```json
{
  "category": {
    "id": "category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83",
    "name": "Handbook",
    "slug": "handbook",
    "description": "How we work.",
    "color": "#9949b6",
    "updatedAt": "2026-08-17T09:02:10.000Z"
  }
}
```

### `DELETE /spaces/:spaceId/categories/:id`

- **Auth**: session, access token or job token; `editor` on this category.
- **Returns**: `200 { success: true }`.

```bash
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/categories/category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83"
```

```json
{ "success": true }
```

## Permissions

### `GET /spaces/:spaceId/permissions`

- **Auth**: session; `editor` on the space, or `owner` with `allResources=true`.
- **Query**: `type` (`role` | `feature` | `all`, default `all`), `resourceType`
  (default `space`), `resourceId` (default `spaceId`), `allResources` (`"true"` lists
  role grants on every resource in the space rather than one).
- **Returns**: `200 { permissions: Array<{ type: "role"|"feature", permission }> }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/permissions?type=all"
```

```json
{
  "permissions": [
    {
      "type": "role",
      "permission": {
        "resourceType": "space",
        "resourceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
        "userId": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
        "groupId": null,
        "permission": "owner",
        "createdAt": "2026-02-11T10:04:18.000Z"
      }
    },
    {
      "type": "feature",
      "permission": {
        "resourceType": "feature",
        "resourceId": "view_audit",
        "userId": null,
        "groupId": "engineering",
        "permission": "deny",
        "createdAt": "2026-05-04T12:30:00.000Z"
      }
    }
  ]
}
```

### `POST /spaces/:spaceId/permissions`

- **Auth**: session. A role write is authorized on the privilege it moves, not on the
  action name — every rule below holds however the request is spelled:
  - granting `owner` anywhere but `space` scope → `400`, whoever asks: owner is
    authority over the space, and below that scope it names nothing
  - writing an `owner` entry at `space` scope → caller must be `owner`
  - overwriting or removing an existing `owner` entry → caller must be `owner`
  - withdrawing access (a revoke, or a grant of a weaker role) outside
    `document`/`document_tree` scope → caller must be `owner`
  - any scope other than `document`/`document_tree`/`category` — `space` included, so
    space membership sits beside renaming and deletion → caller must be `owner`
  - any role write naming a `groupId` — grant or revoke, at any scope, including the
    synthetic `public` group that exposes the resource to unauthenticated callers →
    caller must be `owner`
  - all other role grants/revokes → caller must be `editor`
  - any `feature` operation → caller must be `owner`
- **Body**: `type` (`"role"` | `"feature"`, required), `roleOrFeature` (string,
  required — role: `viewer`/`editor`/`owner`; feature: one of the `Feature` values),
  `userId?` or `email?` (resolved to a userId via case-insensitive exact match, 404 if
  no account) or `groupId?` (one of the three identity fields required),
  `action` (required — roles: `"grant"` | `"revoke"`; features: `"grant"` | `"deny"` |
  `"revoke"`), `resourceType?` (default `space`), `resourceId?` (default `spaceId`).
  Roles have no `deny`: the role model is additive, so `deny` on a role is a 400 —
  roles are revoked. Only features have a real negative entry.
- **Behavior**: a write that would leave the space with no owner is refused with
  `400 A space must have at least one owner`.
- **Returns**: `200 { permission }` (grant/deny) or `200 { success: true }` (revoke).

Share one page with a colleague by email:

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "type": "role",
        "roleOrFeature": "editor",
        "email": "grace@acme.test",
        "action": "grant",
        "resourceType": "document",
        "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
      }' \
  "$VEKTOR/spaces/$SPACE/permissions"
```

```json
{
  "permission": {
    "resourceType": "document",
    "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "userId": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE",
    "groupId": null,
    "permission": "editor",
    "createdAt": "2026-08-17T09:11:07.000Z"
  }
}
```

Publish a page to the world (owner only — it names the `public` group):

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "type": "role",
        "roleOrFeature": "viewer",
        "groupId": "public",
        "action": "grant",
        "resourceType": "document",
        "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
      }' \
  "$VEKTOR/spaces/$SPACE/permissions"
```

### `GET /spaces/:spaceId/permissions/me`

- **Auth**: session; `viewer` on the space.
- **Returns**: `200 { role, features: Record<Feature, boolean>, groups }` — caller's
  effective space role, computed feature flags, and ACL groups.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/permissions/me"
```

```json
{
  "role": "editor",
  "features": {
    "comment": true,
    "view_history": true,
    "view_audit": true,
    "manage_extensions": false
  },
  "groups": ["engineering"]
}
```

## Search

### `GET /spaces/:spaceId/search`

- **Auth**: session / access token / job token / public; `viewer` role.
- **Query**: `q` (string), `limit`/`cursor?` (default 20/max 100), `filters` (JSON
  array string of `{ key: string, value: string|null }`).
- **Behavior**: empty query + no filters → returns an empty result set without
  querying. Public-space access is treated as a trusted view (no per-document ACL
  filtering) for search purposes. Stale document indexes are refreshed before the query
  reads them. `cursor` is an opaque index into the relevance-ranked, in-memory result
  set (not a DB-level seek).
- **Returns**: `200 { results, nextCursor, query, limit, filters }`. `400` for
  malformed `filters`.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  --get \
  --data-urlencode "q=launch checklist" \
  --data-urlencode 'filters=[{"key":"status","value":"draft"}]' \
  --data-urlencode "limit=1" \
  "$VEKTOR/spaces/$SPACE/search"
```

```json
{
  "results": [
    {
      "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "slug": "launch-plan",
      "type": null,
      "content": "<h1>Launch plan</h1>…",
      "currentRev": 12,
      "publishedRev": 12,
      "properties": { "title": "Launch plan", "status": "draft" },
      "parentId": null,
      "readonly": false,
      "archived": false,
      "createdAt": "2026-07-01T08:00:00.000Z",
      "updatedAt": "2026-08-17T08:19:40.000Z",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
      "rank": 0.87,
      "snippet": "…the <mark>launch checklist</mark> covers…"
    }
  ],
  "nextCursor": "1",
  "query": "launch checklist",
  "limit": 1,
  "filters": [{ "key": "status", "value": "draft" }]
}
```

### `POST /spaces/:spaceId/search/rebuild`

- **Auth**: session; `owner` on the space.
- **Returns**: `200` with a bare JSON string as the message; the work (re-embedding
  every document in the space) runs before the response.

```bash
curl -sS -X POST -b "$COOKIE" "$VEKTOR/spaces/$SPACE/search/rebuild"
```

```json
"Search embeddings rebuilt successfully"
```

## Access tokens

### `GET /spaces/:spaceId/access-tokens`

- **Auth**: session; `editor` on the space.
- **Returns**: `200 { tokens: Array<Token & { resources }> }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/access-tokens"
```

```json
{
  "tokens": [
    {
      "id": "token_6d81f4a9-2b70-4c3e-95af-1d84e0b7c265",
      "name": "CI import",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
      "createdAt": "2026-06-01T07:00:00.000Z",
      "expiresAt": "2026-12-01T07:00:00.000Z",
      "lastUsedAt": "2026-08-17T06:12:00.000Z",
      "revokedAt": null,
      "resources": [
        {
          "resourceType": "space",
          "resourceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
          "permission": "editor"
        }
      ]
    }
  ]
}
```

### `POST /spaces/:spaceId/access-tokens`

- **Auth**: session; `owner` on the space — issuing a token is a delegation of the
  caller's own authority.
- **Body**: `name` (non-empty string, required), `permission` (string, required —
  `viewer`/`editor`/`owner`, or the special value `"extensions"` for a space-wide
  `manage_extensions` capability grant with no resource), `resourceType`/`resourceId`
  (required unless `permission === "extensions"`), `expiresInDays?` (number greater
  than 0 and at most 3650).
- **Behavior**: a grant may target `space`, `document`, `category` or `extension`
  (secrets and features have their own narrower flows), and `owner` only at `space`
  scope — anything else is a `400`.
- **Returns**: `201 { id, token, resources, message }` — the raw token string is only
  ever returned here.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "name": "CI import",
        "permission": "editor",
        "resourceType": "space",
        "resourceId": "'"$SPACE"'",
        "expiresInDays": 183
      }' \
  "$VEKTOR/spaces/$SPACE/access-tokens"
```

```json
{
  "id": "token_6d81f4a9-2b70-4c3e-95af-1d84e0b7c265",
  "token": "at_9f1cb37a0d5e48c2b6a71f8043e29dbc5471aa9e2c60d8f31b74e05ca6d92f8b1",
  "resources": [
    {
      "resourceType": "space",
      "resourceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
      "permission": "editor"
    }
  ],
  "message": "Token created successfully. Make sure to save it - you won't be able to see it again!"
}
```

### `GET /spaces/:spaceId/access-tokens/:tokenId`

- **Auth**: session; `editor` on the space.
- **Returns**: `200 { token: { ...tokenFields, resources } }`. `404` if missing.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/access-tokens/token_6d81f4a9-2b70-4c3e-95af-1d84e0b7c265"
```

```json
{
  "token": {
    "id": "token_6d81f4a9-2b70-4c3e-95af-1d84e0b7c265",
    "name": "CI import",
    "expiresAt": "2026-12-01T07:00:00.000Z",
    "revokedAt": null,
    "resources": [
      {
        "resourceType": "space",
        "resourceId": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
        "permission": "editor"
      }
    ]
  }
}
```

### `PATCH /spaces/:spaceId/access-tokens/:tokenId`

Revokes a token (soft delete — the row stays for the audit trail).

- **Auth**: session; `owner` on the space.
- **Returns**: `200 { message }`. `404` if missing.

```bash
curl -sS -X PATCH -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/access-tokens/token_6d81f4a9-2b70-4c3e-95af-1d84e0b7c265"
```

```json
{ "message": "Token revoked successfully" }
```

### `DELETE /spaces/:spaceId/access-tokens/:tokenId`

- **Auth**: session; `owner` on the space.
- **Returns**: `200 { message }` (hard delete). `404` if missing.

```bash
curl -sS -X DELETE -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/access-tokens/token_6d81f4a9-2b70-4c3e-95af-1d84e0b7c265"
```

```json
{ "message": "Token deleted successfully" }
```

## Share links

A link is a credential row like an access token, minted by an editor rather than an
owner, and always `viewer`. It is opened at `/s/:linkId` — not under `/api` — and
serves a read-only render of the page. These endpoints manage them; none of them
resolves an access token, and the token endpoints do not resolve a link.

### `GET /spaces/:spaceId/share-links`

- **Auth**: session; `editor` on that document.
- **Query**: `documentId` (required).
- **Returns**: `200 { links }` — every link on the page, at `document` and
  `document_tree` scope, without secrets: a password shows as `hasPassword`.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/share-links?documentId=doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{
  "links": [
    {
      "id": "share_0d5b7e12-9c34-4a86-b1f0-72e5c9a3d648",
      "name": "Launch plan for the agency",
      "resourceType": "document",
      "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "hasPassword": true,
      "expiresAt": "2026-09-16T08:41:02.000Z",
      "lastUsedAt": "2026-08-17T07:55:10.000Z",
      "createdAt": "2026-08-17T07:40:00.000Z",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
      "revokedAt": null
    }
  ]
}
```

### `POST /spaces/:spaceId/share-links`

- **Auth**: session; `editor` on the target resource.
- **Body**: `name` (non-empty string, required), `resourceType` (`document` or
  `document_tree`), `resourceId` (required), `expiresInDays` (number greater than 0
  and at most 365, **required** — a link outlives its creator, so nothing else retires
  it), `password?` (at least 8 characters).
- **Returns**: `201 { id, path }` — `path` is the link.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "name": "Launch plan for the agency",
        "resourceType": "document",
        "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
        "expiresInDays": 30,
        "password": "hunter-two-hunter"
      }' \
  "$VEKTOR/spaces/$SPACE/share-links"
```

```json
{
  "id": "share_0d5b7e12-9c34-4a86-b1f0-72e5c9a3d648",
  "path": "/s/share_0d5b7e12-9c34-4a86-b1f0-72e5c9a3d648"
}
```

### `DELETE /spaces/:spaceId/share-links/:linkId`

- **Auth**: session; `editor` on what the link shares — whoever may share it may take
  it back.
- **Behavior**: a soft revoke; the row and its grant stay, so it is reversible.
- **Returns**: `200 { message }`. `404` if missing.

```bash
curl -sS -X DELETE -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/share-links/share_0d5b7e12-9c34-4a86-b1f0-72e5c9a3d648"
```

```json
{ "message": "Share link revoked" }
```

### `GET /s/:linkId[/:documentId]`

- **Auth**: the URL itself; HTTP Basic on top when the link carries a password
  (`401 WWW-Authenticate: Basic`). Any other failure is `404`.
- **Returns**: a read-only HTML render, and a `vektor.share_links` cookie naming the
  link. Its attachments are then read from the ordinary `/spaces/:spaceId/uploads/*`
  URL: the cookie is what makes those requests authenticated, and they meet the same
  document check every other viewer meets.

Not under `/api/v1` — this is the page a recipient opens. A password-protected link
answers the first request with a challenge:

```bash
curl -sS -D - -o /dev/null \
  "https://vektor.example.com/s/share_0d5b7e12-9c34-4a86-b1f0-72e5c9a3d648"
```

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="Launch plan for the agency"
```

---

## Uploads

### `GET /spaces/:spaceId/uploads`

- **Auth**: session / access token / job token; `viewer`, or a resource grant alone —
  every row is filtered against the documents that grant reaches.
- **Returns**: `200 { files: Array<FileInfo & { url }> }`.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/uploads"
```

```json
{
  "files": [
    {
      "key": "3f/3f9c2a1d7e04b58c6f1a9d3e57b20c84fa61d9e3c705b8a24f16d0e93cb7a582.png",
      "size": 184320,
      "updatedAt": "2026-08-16T13:45:02.000Z",
      "originalName": "architecture.png",
      "mimeType": "image/png",
      "url": "/api/v1/spaces/space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240/uploads/3f/3f9c…png"
    }
  ]
}
```

### `POST /spaces/:spaceId/uploads`

- **Auth**: session, access token or job token; `editor` on the document named by
  `documentId`, or on the space for an upload that belongs to no document. A caller with
  no editor reach into the space at all is refused before the body is parsed.
- **Body**: multipart form — `file` (blob, required), `filename?`, `documentId?`
  (must pass `isSafeUploadIdPart`).
- **Behavior**: 1.25GB size cap per upload (job uploads are trusted and exempt).
  Content-addressed storage key (`sha256[:2]/sha256.ext`), so re-uploading identical
  bytes lands on the existing row: the first document to claim a file keeps it, since
  that document's ACL is what serves it. Text is extracted synchronously and stored for
  search; if `documentId` is given, the parent document's embedding is re-indexed
  asynchronously.
- **Returns**: `200 { url, key }`. `400` for missing file / invalid `documentId` /
  oversize.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -F "file=@architecture.png" \
  -F "documentId=doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31" \
  "$VEKTOR/spaces/$SPACE/uploads"
```

```json
{
  "url": "/api/v1/spaces/space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240/uploads/3f/3f9c…png",
  "key": "3f/3f9c2a1d7e04b58c6f1a9d3e57b20c84fa61d9e3c705b8a24f16d0e93cb7a582.png"
}
```

### `GET /spaces/:spaceId/uploads/*path`

- **Auth**: the document an upload hangs off is what authorizes it — `viewer` on that
  document, which is how a public share, a resource grant, a share link the caller has
  opened, and an archive all reach the file. A file belonging to no document (a workflow
  artifact) takes `viewer` on the space.
- **Query**: image/video transform params (via `parseTransformParams`, e.g. resize).
- **Behavior**: path-traversal-checked; resolves via storage adapter redirect,
  on-the-fly transform+cache, or local filesystem stream. Supports HTTP `Range`
  requests (206 partial content) for video playback. Sets a restrictive CSP,
  `nosniff`, and forces download (`Content-Disposition`) for active content types
  (svg/html) to prevent stored XSS. 1-year immutable cache.
- **Returns**: file stream, `404` if missing, `416` for unsatisfiable ranges.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -o thumb.png \
  "$VEKTOR/spaces/$SPACE/uploads/3f/3f9c…png?width=320"
```

### `DELETE /spaces/:spaceId/uploads/*path`

- **Auth**: session, access token or job token; `editor` on the file's document, or on
  the space when it has none.
- **Returns**: `204` (idempotent — removes storage object + file-table row).

```bash
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/uploads/3f/3f9c…png"
```

## Secrets

Space-scoped secret values (e.g. API keys used by extensions/jobs). Every operation
takes `owner`: a secret is instance credentials, not space content.

### `GET /spaces/:spaceId/secrets`

- **Auth**: session; `owner` on the space.
- **Returns**: `200 { secrets }` — metadata only (names/description), no values.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/secrets"
```

```json
{
  "secrets": [
    {
      "name": "GITHUB_TOKEN",
      "description": "Used by the release-notes job",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0",
      "createdAt": "2026-04-02T10:00:00.000Z",
      "updatedAt": "2026-08-01T09:30:00.000Z"
    }
  ]
}
```

### `POST /spaces/:spaceId/secrets`

- **Auth**: session; `owner` on the space.
- **Body**: `name` (string, required, sanitized via `sanitizeSecretName` — `400` if
  invalid), `value` (string, required), `description?` (string or null).
- **Returns**: `201 { secret }` (upsert — same endpoint updates an existing secret with
  that name).

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "name": "GITHUB_TOKEN", "value": "ghp_…", "description": "Used by the release-notes job" }' \
  "$VEKTOR/spaces/$SPACE/secrets"
```

```json
{
  "secret": {
    "name": "GITHUB_TOKEN",
    "description": "Used by the release-notes job",
    "updatedAt": "2026-08-17T09:40:11.000Z"
  }
}
```

### `GET /spaces/:spaceId/secrets/:name`

- **Auth**: session, access token or job token; `owner` on the space. A job token
  carrying no user is refused (`403`) — the value is resolved per user.
- **Behavior**: `getSpaceSecretValueForUser` applies per-user secret-access filtering;
  a secret that exists but is unreadable for this user is `403`, one that does not
  exist at all is `404`.
- **Returns**: `200 { name, value }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/secrets/GITHUB_TOKEN"
```

```json
{ "name": "GITHUB_TOKEN", "value": "ghp_…" }
```

### `PUT /spaces/:spaceId/secrets/:name`

- **Auth**: session; `owner` on the space.
- **Body**: `value` (string, required), `description?` (string or null).
- **Returns**: `200 { secret }` (upsert by name from the path, sanitized).

```bash
curl -sS -X PUT -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "value": "ghp_rotated…" }' \
  "$VEKTOR/spaces/$SPACE/secrets/GITHUB_TOKEN"
```

```json
{ "secret": { "name": "GITHUB_TOKEN", "updatedAt": "2026-08-17T09:44:02.000Z" } }
```

### `DELETE /spaces/:spaceId/secrets/:name`

- **Auth**: session; `owner` on the space.
- **Returns**: `200 { success: true }`. `404` if not found.

```bash
curl -sS -X DELETE -b "$COOKIE" "$VEKTOR/spaces/$SPACE/secrets/GITHUB_TOKEN"
```

```json
{ "success": true }
```

### `HEAD /spaces/:spaceId/secrets/:name`

- **Auth**: session; `owner` on the space.
- **Returns**: `200` empty body if the secret exists; `404` otherwise.

```bash
curl -sS -I -b "$COOKIE" "$VEKTOR/spaces/$SPACE/secrets/GITHUB_TOKEN"
```

## Settings — AI provider

### `GET /spaces/:spaceId/settings/ai-provider`

- **Auth**: session; `editor` on the space.
- **Returns**: `200 { aiProvider: meta }` — metadata only (never the raw API key).

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/settings/ai-provider"
```

```json
{
  "aiProvider": {
    "provider": "anthropic",
    "model": "claude-opus-5",
    "hasApiKey": true,
    "baseUrl": null,
    "updatedAt": "2026-08-10T11:20:00.000Z"
  }
}
```

### `PUT /spaces/:spaceId/settings/ai-provider`

- **Auth**: session; `owner` on the space.
- **Body**: `provider` (required — `"ollama"` | `"anthropic"` | `"openai"` |
  `"openrouter"` | `"opencode-zen"`), `model` (non-empty string, required).
  For `ollama`: `baseUrl` (non-empty string, required; trailing slash stripped, and
  validated against the SSRF policy for the URL that will actually be requested). For
  the others: `apiKey` (non-empty string, required).
- **Returns**: `200 { aiProvider: meta }`. `400` for missing/unknown provider fields or
  a base URL the server may not call.

```bash
curl -sS -X PUT -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "provider": "anthropic", "model": "claude-opus-5", "apiKey": "sk-ant-…" }' \
  "$VEKTOR/spaces/$SPACE/settings/ai-provider"
```

```json
{
  "aiProvider": {
    "provider": "anthropic",
    "model": "claude-opus-5",
    "hasApiKey": true,
    "updatedAt": "2026-08-17T09:50:00.000Z"
  }
}
```

### `DELETE /spaces/:spaceId/settings/ai-provider`

- **Auth**: session; `owner` on the space.
- **Returns**: `200 { success: true }`.

```bash
curl -sS -X DELETE -b "$COOKIE" "$VEKTOR/spaces/$SPACE/settings/ai-provider"
```

```json
{ "success": true }
```

## Integrations (OAuth)

Connections are per user, not per space: each member connects their own account.

### `GET /spaces/:spaceId/integrations`

- **Auth**: session; `viewer` on the space.
- **Returns**: `200 { connections }` — one entry per known provider, connected or not,
  for the calling user.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/integrations"
```

```json
{
  "connections": [
    {
      "provider": "github",
      "label": "GitHub",
      "configured": true,
      "missingConfig": [],
      "connected": true,
      "externalAccountId": "1421903",
      "externalUsername": "ada",
      "instanceUrl": "https://api.github.com",
      "scopes": ["repo", "read:org"],
      "accessTokenExpiresAt": "2026-08-17T10:40:00.000Z",
      "createdAt": "2026-07-20T08:00:00.000Z",
      "updatedAt": "2026-08-17T09:40:00.000Z",
      "lastUsedAt": "2026-08-17T09:41:12.000Z"
    },
    {
      "provider": "gitlab",
      "label": "GitLab",
      "configured": false,
      "missingConfig": ["VEKTOR_GITLAB_CLIENT_ID", "VEKTOR_GITLAB_CLIENT_SECRET"],
      "connected": false,
      "externalAccountId": null,
      "externalUsername": null,
      "instanceUrl": null,
      "scopes": [],
      "accessTokenExpiresAt": null,
      "createdAt": null,
      "updatedAt": null,
      "lastUsedAt": null
    }
  ]
}
```

### `GET /spaces/:spaceId/integrations/:provider`

- **Auth**: session; `viewer` on the space. `provider` must be a known
  `OAuthIntegrationProvider` (else `400`).
- **Returns**: `200 { connection }` (same shape as one list entry).

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/integrations/github"
```

```json
{
  "connection": {
    "provider": "github",
    "label": "GitHub",
    "configured": true,
    "connected": true,
    "externalUsername": "ada",
    "scopes": ["repo", "read:org"]
  }
}
```

### `DELETE /spaces/:spaceId/integrations/:provider`

- **Auth**: session; `viewer` on the space.
- **Returns**: `200 { success: true }` (disconnects this user's connection).

```bash
curl -sS -X DELETE -b "$COOKIE" "$VEKTOR/spaces/$SPACE/integrations/github"
```

```json
{ "success": true }
```

### `POST /spaces/:spaceId/integrations/:provider/connect`

- **Auth**: session; `viewer` on the space.
- **Body**: `redirectTo?` (string, normalized to an internal path).
- **Behavior**: provider must be configured (else `400` listing missing config keys).
  Generates OAuth `state` + PKCE verifier/challenge, persists pending state.
- **Returns**: `200 { authorizeUrl }` — client redirects the browser here.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "redirectTo": "/acme/settings/integrations" }' \
  "$VEKTOR/spaces/$SPACE/integrations/github/connect"
```

```json
{
  "authorizeUrl": "https://github.com/login/oauth/authorize?client_id=Iv1.5f…&state=8c1f…&code_challenge=Yr2…&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fvektor.example.com%2Fapi%2Fv1%2Fspaces%2Fspace_4f2b…%2Fintegrations%2Fgithub%2Fcallback"
}
```

### `GET /spaces/:spaceId/integrations/:provider/callback`

- **Auth**: session; `viewer` on the space. (Not JSON — a browser redirect target.)
  Authorization happens before anything else, so a refusal is a real 401/403 rather
  than a redirect that would leak the space slug.
- **Query**: `code`, `state` (from provider), or `error`/`error_description`.
- **Behavior**: consumes the pending OAuth state (validated per user/provider),
  exchanges the code, fetches the external account identity, upserts the
  integration credential.
- **Returns**: `302` redirect to the original `redirectTo` (or a space-root
  fallback) with query params `integration=<provider>&status=connected|error
  [&message=...]`.

```http
HTTP/1.1 302 Found
Location: /acme/settings/integrations?integration=github&status=connected
```

### `POST /spaces/:spaceId/integrations/:provider/proxy`

- **Auth**: session or job token; `viewer` on the space. A job token with no user id is
  refused — the request is made with a specific member's credential.
- **Body**: `{ method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE" (default GET), path:
  string (required), headers?: Record<string,string> (only `accept`/`content-type`
  forwarded), body?: string }`.
- **Behavior**: resolves the caller's stored OAuth credential for that provider,
  refreshes the access token if within 60s of expiry, and builds the target URL against
  the provider's configured origin — a cross-origin `path` is rejected, and GitLab paths
  are pinned under `/api/v4`. Redirects are not followed (that would re-send the access
  token wherever the upstream points); the 3xx is relayed instead.
- **Returns**: `200 { ok, status, statusText, headers (subset: content-type, location,
  link, x-*-page/total), body: string }` — the upstream response is always wrapped in a
  `200`, with the real upstream status reported inside the JSON.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "method": "GET", "path": "/user/repos?per_page=1" }' \
  "$VEKTOR/spaces/$SPACE/integrations/github/proxy"
```

```json
{
  "ok": true,
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "link": "<https://api.github.com/user/repos?per_page=1&page=2>; rel=\"next\""
  },
  "body": "[{\"id\":42,\"full_name\":\"acme/handbook\"}]"
}
```

## Jobs

### `POST /spaces/:spaceId/jobs/run`

- **Auth**: session, access token or job token; `editor` role.
- **Body**: `{ jobId: string (required), inputs?: Record<string, unknown>, stream?:
  boolean }`. `jobId`s are unique within a space (no `extensionId` needed); the
  handler resolves which extension/entry owns the job.
- **Behavior**: extracts the job's extension package and runs it in a sandbox.
  Non-streaming: runs to completion inline. Streaming (`stream: true`): SSE.
- **Returns** (non-stream): `200 { outputs, logs }`.
- **Returns** (stream): `text/event-stream` of `data: { type: "log", message }` /
  `{ type: "output", outputs }` / `{ type: "error", error }`, then `data: [DONE]`.
- `400` if `jobId` is missing/unknown or its extension package is missing.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "jobId": "release-notes", "inputs": { "milestone": "2026.08" } }' \
  "$VEKTOR/spaces/$SPACE/jobs/run"
```

```json
{
  "outputs": { "documentId": "doc_9a71fe30-4c28-4d17-8b6e-05f2a7c91d84", "issues": 14 },
  "logs": ["Fetched 14 issues", "Wrote release notes"]
}
```

Streaming variant:

```bash
curl -sS -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "jobId": "release-notes", "stream": true }' \
  "$VEKTOR/spaces/$SPACE/jobs/run"
```

```text
data: {"type":"log","message":"Fetched 14 issues"}

data: {"type":"output","outputs":{"issues":14}}

data: [DONE]
```

### `GET /spaces/:spaceId/jobs/runs`

- **Auth**: session; `viewer` on the space.
- **Query**: `jobId?`, `scheduleId?`, `limit`/`cursor?` (default 50/max 500).
- **Behavior**: lists all recorded job executions — manual, workflow-node, and
  cron-scheduled runs. Cursor-paginated at the DB level, keyset on
  `(queuedAt, id)`.
- **Returns**: `200 { runs, limit, nextCursor }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/jobs/runs?jobId=release-notes&limit=1"
```

```json
{
  "runs": [
    {
      "id": "run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94",
      "scheduleId": null,
      "jobId": "release-notes",
      "trigger": "single_job",
      "status": "succeeded",
      "error": null,
      "queuedAt": "2026-08-17T08:00:00.000Z",
      "startedAt": "2026-08-17T08:00:01.000Z",
      "finishedAt": "2026-08-17T08:00:09.000Z",
      "initiatedBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
    }
  ],
  "limit": 1,
  "nextCursor": "eyJ0IjoxNzU1NDI4NDAwMDAwLCJpZCI6InJ1bl8yYzlkNDdiOC02MWZhLTRlMDctOWM4ZC0zYjVhMWU2ZjBkOTQifQ"
}
```

## Workflows — runs

### `GET /spaces/:spaceId/workflows/runs`

- **Auth**: session, access token or job token; `viewer` role. Runs are filtered to
  ones whose backing document the caller can read.
- **Query**: `documentId?` (returns just the latest run for that document, `404` if
  none/inaccessible), `sourceExtensionId?` (filter), `filterDocumentId?` (narrow list
  to one document), `limit`/`cursor?` (default 20/max 200, only used in list mode).
- **Returns** (with `documentId`): `200 { runId, status }`.
- **Returns** (list mode): `200 { runs: Array<{ runId, documentId, documentSlug,
  documentTitle, status, createdAt, startedAt, finishedAt, sourceExtensionId,
  runtimeInputs }>, limit, nextCursor }`.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/workflows/runs?limit=1"
```

```json
{
  "runs": [
    {
      "runId": "run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94",
      "documentId": "doc_8e0b5a92-77c1-4f43-a0d6-91b3e4c72f58",
      "documentSlug": "nightly-report",
      "documentTitle": "Nightly report",
      "status": "succeeded",
      "createdAt": "2026-08-17T02:00:00.000Z",
      "startedAt": "2026-08-17T02:00:00.000Z",
      "finishedAt": "2026-08-17T02:01:44.000Z",
      "sourceExtensionId": null,
      "runtimeInputs": { "window": "24h" }
    }
  ],
  "limit": 1,
  "nextCursor": null
}
```

### `POST /spaces/:spaceId/workflows/runs`

- **Auth**: session, access token or job token; `editor` role.
- **Body**: `{ documentId: string, inputs?: Record<string, unknown>,
  sourceExtensionId?: string, resumeFromRunId?: string }`. The target document must
  exist and have `type === "workflow"` (else `400`/`404`).
- **Behavior**: starts the run asynchronously; does not block on completion.
  `resumeFromRunId` inherits the prior run's document and inputs from its resume
  artifact — not from the document's summarized properties — and seeds its step cache so
  completed steps replay instead of re-executing; `documentId`/`inputs` in the body
  still win. Resuming a run that is still pending or running, or one with no resume
  state, is a `400`.
- **Returns**: `202 { runId }`.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "documentId": "doc_8e0b5a92-77c1-4f43-a0d6-91b3e4c72f58", "inputs": { "window": "24h" } }' \
  "$VEKTOR/spaces/$SPACE/workflows/runs"
```

```json
{ "runId": "run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94" }
```

Retry a failed run, replaying the steps that already succeeded:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "resumeFromRunId": "run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94" }' \
  "$VEKTOR/spaces/$SPACE/workflows/runs"
```

### `GET /spaces/:spaceId/workflows/runs/:runId`

- **Auth**: session, access token or job token; `viewer` role, plus read access to the
  run's document.
- **Returns**: `200 { runId, documentId, status, createdAt, startedAt, completedAt,
  sourceExtensionId, runtimeInputs, error, logs, resultArtifact: {key,url}|null,
  logArtifact: {key,url}|null }`. `404` if the run doesn't exist or isn't readable.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/workflows/runs/run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94"
```

```json
{
  "runId": "run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94",
  "documentId": "doc_8e0b5a92-77c1-4f43-a0d6-91b3e4c72f58",
  "status": "succeeded",
  "createdAt": "2026-08-17T02:00:00.000Z",
  "startedAt": "2026-08-17T02:00:00.000Z",
  "completedAt": "2026-08-17T02:01:44.000Z",
  "sourceExtensionId": null,
  "runtimeInputs": { "window": "24h" },
  "error": null,
  "logs": ["step fetch ok", "step summarise ok"],
  "resultArtifact": {
    "key": "workflow-runs/run_2c9d47b8/result.json",
    "url": "/api/v1/spaces/space_4f2b…/uploads/workflow-runs/run_2c9d47b8/result.json"
  },
  "logArtifact": null
}
```

### `POST` / `DELETE /spaces/:spaceId/workflows/runs/:runId`

Both methods cancel the run.

- **Auth**: session; `editor` on the space.
- **Returns**: `200 { ok: true }`. `404` if the run is not found.

```bash
curl -sS -X DELETE -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/workflows/runs/run_2c9d47b8-61fa-4e07-9c8d-3b5a1e6f0d94"
```

```json
{ "ok": true }
```

## Workflows — schedules

Cron-driven execution of `type: "workflow"` documents. Replaced the older per-job
schedule mechanism. Every operation takes `editor` on the space — the same role as
starting a run by hand.

### `GET /spaces/:spaceId/workflows/schedules`

- **Returns**: `200 { schedules }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/workflows/schedules"
```

```json
{
  "schedules": [
    {
      "id": "sched_5e30a1c7-9b48-4f26-83da-7c14e5029b6f",
      "documentId": "doc_8e0b5a92-77c1-4f43-a0d6-91b3e4c72f58",
      "cronExpression": "0 2 * * *",
      "timezone": "Europe/Berlin",
      "inputs": { "window": "24h" },
      "enabled": true,
      "nextRunAt": "2026-08-18T00:00:00.000Z",
      "lastRunAt": "2026-08-17T00:00:00.000Z",
      "createdAt": "2026-06-14T12:00:00.000Z",
      "updatedAt": "2026-08-01T07:30:00.000Z",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
    }
  ]
}
```

### `POST /spaces/:spaceId/workflows/schedules`

- **Body**: `documentId` (string, required — must reference an existing document of
  `type === "workflow"`), `cronExpression` (string, required — standard 5-field
  cron, validated), `timezone?` (IANA string), `inputs?` (object), `enabled?`
  (boolean).
- **Returns**: `200 { schedule }`. `400` for invalid cron, missing document, or wrong
  document type.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "documentId": "doc_8e0b5a92-77c1-4f43-a0d6-91b3e4c72f58",
        "cronExpression": "0 2 * * *",
        "timezone": "Europe/Berlin",
        "inputs": { "window": "24h" }
      }' \
  "$VEKTOR/spaces/$SPACE/workflows/schedules"
```

```json
{
  "schedule": {
    "id": "sched_5e30a1c7-9b48-4f26-83da-7c14e5029b6f",
    "documentId": "doc_8e0b5a92-77c1-4f43-a0d6-91b3e4c72f58",
    "cronExpression": "0 2 * * *",
    "timezone": "Europe/Berlin",
    "enabled": true,
    "nextRunAt": "2026-08-18T00:00:00.000Z"
  }
}
```

### `GET /spaces/:spaceId/workflows/schedules/:scheduleId`

- **Returns**: `200 { schedule }`. `404` if missing.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/workflows/schedules/sched_5e30a1c7-9b48-4f26-83da-7c14e5029b6f"
```

### `PATCH /spaces/:spaceId/workflows/schedules/:scheduleId`

- **Body**: any of `cronExpression?`, `timezone?` (string or null), `inputs?`
  (object or null), `enabled?` (boolean) — all optional; the cron is re-validated when
  `cronExpression`/`timezone` change.
- **Returns**: `200 { schedule }`. `404` if missing.

```bash
curl -sS -X PATCH -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "enabled": false }' \
  "$VEKTOR/spaces/$SPACE/workflows/schedules/sched_5e30a1c7-9b48-4f26-83da-7c14e5029b6f"
```

```json
{
  "schedule": {
    "id": "sched_5e30a1c7-9b48-4f26-83da-7c14e5029b6f",
    "enabled": false,
    "nextRunAt": null
  }
}
```

### `DELETE /spaces/:spaceId/workflows/schedules/:scheduleId`

- **Behavior**: run history for the schedule is preserved.
- **Returns**: `200 { success: true }`. `404` if missing.

```bash
curl -sS -X DELETE -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/workflows/schedules/sched_5e30a1c7-9b48-4f26-83da-7c14e5029b6f"
```

```json
{ "success": true }
```

## AI chat sessions

Per-user, per-space saved chat session state (used by the ACP chat UI). All four
endpoints take a session and `viewer` on the space, and only ever see the caller's own
sessions.

### `GET /spaces/:spaceId/ai-chat/sessions`

- **Returns**: `200 { sessions }` (summaries, caller's own sessions only).

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/ai-chat/sessions"
```

```json
{
  "sessions": [
    {
      "id": "chat_2026-08-17-1",
      "title": "Launch plan review",
      "createdAt": 1755410000000,
      "updatedAt": 1755428400000
    }
  ]
}
```

### `GET /spaces/:spaceId/ai-chat/sessions/:sessionId`

- **Returns**: `200 { session }`. `404` if not found (for this user).

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/ai-chat/sessions/chat_2026-08-17-1"
```

### `PUT /spaces/:spaceId/ai-chat/sessions/:sessionId`

- **Body**: full session object — `id` (must equal path param), `spaceId` (must
  equal path param), `title` (non-empty string), `createdAt`/`updatedAt` (numbers),
  `messages` (array), `conversationHistory` (array), `shellSnapshot?` (string or
  null).
- **Returns**: `200 { session }` (upsert).

```bash
curl -sS -X PUT -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "id": "chat_2026-08-17-1",
        "spaceId": "'"$SPACE"'",
        "title": "Launch plan review",
        "createdAt": 1755410000000,
        "updatedAt": 1755428400000,
        "messages": [{ "role": "user", "content": "Summarise this", "timestamp": 1755428400000 }],
        "conversationHistory": [{ "role": "user", "content": "Summarise this" }],
        "shellSnapshot": null
      }' \
  "$VEKTOR/spaces/$SPACE/ai-chat/sessions/chat_2026-08-17-1"
```

```json
{
  "session": {
    "id": "chat_2026-08-17-1",
    "title": "Launch plan review",
    "createdAt": 1755410000000,
    "updatedAt": 1755428400000,
    "messages": [{ "role": "user", "content": "Summarise this", "timestamp": 1755428400000 }],
    "conversationHistory": [{ "role": "user", "content": "Summarise this" }],
    "shellSnapshot": null
  }
}
```

### `DELETE /spaces/:spaceId/ai-chat/sessions/:sessionId`

- **Returns**: `200 { success: true }`. `404` if not found.

```bash
curl -sS -X DELETE -b "$COOKIE" "$VEKTOR/spaces/$SPACE/ai-chat/sessions/chat_2026-08-17-1"
```

```json
{ "success": true }
```

## Documents

### `GET /spaces/:spaceId/documents`

- **Auth**: session / access token / job token / public; `viewer`, or a
  document/tree/category grant alone — the sidebar of a caller shared into one subtree
  reads its documents here.
- **Query**: `limit` (≤500, default 50), `cursor?`, `type?` (filter),
  `categorySlugs?` (comma-separated), `grouped` (`"true"` groups results by
  category), `parentId?` (list direct children of a parent instead of top-level
  listing), `includeFiles` (`"true"` — uploaded files are unpaginated, so a listing
  only gets them on request).
- **Behavior**: content is never included in list responses (fetched separately per
  document). `record`-type documents are excluded when filtering by category.
- **Returns**: shape depends on query — `{ documentsByCategory, categorySlugs }`
  (grouped), `{ documents, total, limit }` (category/flat — returns the full
  filtered result set, unpaginated), or `{ documents, total, limit, nextCursor }`
  (`parentId` or default cursor-paginated listing).

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/documents?limit=1"
```

```json
{
  "documents": [
    {
      "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "slug": "launch-plan",
      "type": null,
      "currentRev": 12,
      "publishedRev": 12,
      "parentId": null,
      "readonly": false,
      "archived": false,
      "properties": { "title": "Launch plan", "status": "draft" },
      "createdAt": "2026-07-01T08:00:00.000Z",
      "updatedAt": "2026-08-17T08:19:40.000Z",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
    }
  ],
  "total": 148,
  "limit": 1,
  "nextCursor": "eyJ0IjoxNzU1NDI4NDAwMDAwLCJpZCI6ImRvY19jNThhMWQ3MC0zZTQyLTRiOWYtOGExNi0yZjdkMGM5YjVlMzEifQ"
}
```

### `POST /spaces/:spaceId/documents`

- **Auth**: session, access token or job token; `editor` role. A job token with no user
  id is refused — a document needs an author.
- **Body**: JSON (`Content-Type: application/json`) — `content` (string, required),
  `properties?` (object of property inits, e.g. `{ title, slug, ... }`),
  `parentId?`, `type?`, `slug?`, `createdAt?`/`updatedAt?` (valid date strings;
  accepted only with access-token or job-token authentication, for imports),
  `contentType?` (source content type, e.g. `text/markdown`, converted to HTML).
  Or raw body (any other `Content-Type`) with `X-Document-Type`,
  `X-Document-Title`, `X-Document-Slug` headers.
- **Behavior**: HTML-typed content is sanitized on the way in; canvas/app types store
  serialized JSON and are left alone. `type: "workflow"` additionally requires the
  space's `workflowCreationEnabled` preference not to be `false` (else `403`).
- **Returns**: `201 { document }`. `400` for missing content, an invalid parent, or a
  reserved property key.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "content": "# Launch plan\n\nShip on the 21st.",
        "contentType": "text/markdown",
        "properties": { "title": "Launch plan", "status": "draft" }
      }' \
  "$VEKTOR/spaces/$SPACE/documents"
```

```json
{
  "document": {
    "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "slug": "launch-plan",
    "type": null,
    "content": "<h1>Launch plan</h1><p>Ship on the 21st.</p>",
    "currentRev": 0,
    "publishedRev": null,
    "parentId": null,
    "readonly": false,
    "archived": false,
    "properties": { "title": "Launch plan", "status": "draft" },
    "createdAt": "2026-07-01T08:00:00.000Z",
    "updatedAt": "2026-07-01T08:00:00.000Z",
    "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
  }
}
```

Markdown straight from a file, titled by header:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  -H "X-Document-Title: Runbook" \
  --data-binary @runbook.md \
  "$VEKTOR/spaces/$SPACE/documents"
```

### `GET /spaces/:spaceId/documents/archived`

- **Auth**: session; `editor` on the space — reading an archived document takes
  `editor`, so listing them does too.
- **Query**: `limit`/`cursor?` (default 50/max 500).
- **Returns**: `200 { documents, limit, nextCursor }`.

```bash
curl -sS -b "$COOKIE" "$VEKTOR/spaces/$SPACE/documents/archived?limit=1"
```

```json
{
  "documents": [
    {
      "id": "doc_2d64bf18-90ea-4c77-b3e5-8f0172ac96d3",
      "slug": "old-roadmap",
      "archived": true,
      "properties": { "title": "Old roadmap" },
      "updatedAt": "2026-05-30T15:10:00.000Z"
    }
  ],
  "limit": 1,
  "nextCursor": null
}
```

### `GET /spaces/:spaceId/documents/:documentId`

- **Auth**: session / access token / job token / public, gated on `viewer` normally, or
  `editor` when `draft=true` or `live=true` (unpublished content). `spaceId` may be
  either the space id or its slug; `documentId` may be either the doc id or its slug.
- **Query**: `rev?` (int ≥1 — fetch a specific revision instead of current content),
  `draft` (`"true"` — bypass published-revision resolution), `live` (`"true"` —
  read from the in-memory Yjs collaboration room if the doc is open).
- **Behavior**: `Accept: text/markdown` or `text/plain` returns the content
  converted to Markdown instead of JSON. Workflow-run-type documents (internal) are
  hidden (`404`). CORS headers (`Access-Control-Allow-Origin: *`) are added for
  cross-host embedding. `?rev=` serving exactly the published revision needs no extra
  privilege — the plain read already buys that content — but its metadata does: without
  the `view_history` feature the response carries only `{ rev, content, status: null }`.
  Any other revision requires `view_history`.
- **Returns**: `200 { document, space: { id, slug, name } }` (`document` includes
  `headerImageAspectRatio`), or `200 { revision }` when `rev` is given, or a
  `text/markdown` body. `404` if space/document/revision is missing.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/acme/documents/launch-plan"
```

```json
{
  "document": {
    "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "slug": "launch-plan",
    "type": null,
    "content": "<h1>Launch plan</h1><p>Ship on the 21st.</p>",
    "currentRev": 12,
    "publishedRev": 12,
    "parentId": null,
    "readonly": false,
    "archived": false,
    "properties": { "title": "Launch plan", "status": "draft" },
    "headerImageAspectRatio": null,
    "createdAt": "2026-07-01T08:00:00.000Z",
    "updatedAt": "2026-08-17T08:19:40.000Z",
    "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
  },
  "space": {
    "id": "space_4f2b8c1e-7a93-4d55-b0e1-6c3a9f81d240",
    "slug": "acme",
    "name": "Acme"
  }
}
```

As Markdown, which is what an agent or a CLI usually wants:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: text/markdown" \
  "$VEKTOR/spaces/acme/documents/launch-plan"
```

```markdown
# Launch plan

Ship on the 21st.
```

### `PUT /spaces/:spaceId/documents/:documentId`

- **Auth**: session, access token or job token; `editor` on this document.
- **Query**: `publish=true` — also publish the newly created revision.
- **Body**: JSON — either `{ content: string }` (full content replacement, creates a
  revision) or `{ restore: true }` (revert to the currently-published revision;
  cannot combine with `content`). Or raw body (non-JSON content type).
- **Behavior**: readonly documents (`document.readonly` or in
  `readOnlyDocumentTypes`) always reject writes with `403`. HTML-typed content is
  sanitized before saving.
- **Returns**: `200 { document }` — **`content` is omitted** from the response to avoid
  re-serializing large payloads (the client already has what it sent). A restore
  answers `200 { success: true }`. `404` if the document is missing.

```bash
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "content": "<h1>Launch plan</h1><p>Ship on the 22nd.</p>" }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31?publish=true"
```

```json
{
  "document": {
    "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "slug": "launch-plan",
    "currentRev": 13,
    "publishedRev": 13,
    "properties": { "title": "Launch plan", "status": "draft" },
    "updatedAt": "2026-08-17T10:02:19.000Z"
  }
}
```

### `PATCH /spaces/:spaceId/documents/:documentId`

- **Auth**: session, access token or job token; `editor` on this document.
- **Body**: exactly one of these patch shapes:
  - `properties: Record<string, PropertyPatchValue>` — each value is `null` (delete
    property), a scalar/array, or `{ value, type? }`.
  - `parentId: string | null` — move the document. Takes `editor` on the new parent,
    not read access: document ACLs inherit down the tree, so a move splices the
    document into grants it did not have. Self-parenting and ancestry cycles are `400`.
    Broadcasts a `document_parent_changed` realtime event.
  - `publishedRev: number | null` — publish a specific revision (or unpublish with
    `null`). Loads the revision into the draft (and into the open collaboration room, if
    any), triggers "document published" email notifications plus a "mentioned you" one
    for each user newly mentioned, and is audit-logged.
  - `readonly: boolean` — lock/unlock the document (types in `readOnlyDocumentTypes`,
    e.g. CSV, must stay readonly). Persists the live draft before locking.
    Audit-logged.
- **Returns**: `200 { success: true }` for a parent/publish/readonly patch. A properties
  patch answers `200 {}`, or `200 { slug }` when a `title` patch also claimed a new
  slug. The slug is fixed when the document is created and does not follow later
  renames — the one exception is a slug still derived from the placeholder title a
  document was created with ("Untitled Canvas", …), which the first real title replaces.
  Empty bodies, multiple operations, and unknown fields return `400`; archiving uses
  `DELETE`, not `PATCH`.

```bash
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "properties": { "status": "shipped", "owner": { "value": ["ada"], "type": "people" }, "draftNote": null } }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{}
```

Publishing a revision:

```bash
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "publishedRev": 13 }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{ "success": true }
```

### `DELETE /spaces/:spaceId/documents/:documentId`

- **Auth**: session, access token or job token; `editor` on this document (`editor`
  suffices for archive, `permanent=true` additionally requires `owner`).
- **Query**: `permanent` (`"true"` — hard delete; default is soft archive).
- **Returns**: `200 { success: true }`.

```bash
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{ "success": true }
```

### `POST /spaces/:spaceId/documents/:documentId`

Creates a revision, or a suggestion against one.

- **Auth**: session (`requireUser`) + `viewer` on the document, then per mode —
  `editor` for a full revision, the `comment` feature on this document for
  `mode: "suggestion"`. Authorized before the content is validated, so a refused caller
  gets that verdict rather than a critique of their payload.
- **Body**: JSON — `html` (string, required), `message?` (string), `mode?`
  (`"revision"` | `"suggestion"`, default revision). Or raw body, which can only ever be
  a full revision.
- **Behavior**: readonly documents reject with `403`. `mode: "suggestion"` creates a
  pending-status suggestion revision instead of a normal one, based on the published
  revision or else the latest saved one; a document with neither is a `400`.
- **Returns**: `200 { revision: { id, documentId, rev, checksum, parentRev, status,
  message, createdAt, createdBy } }`.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "html": "<h1>Launch plan</h1><p>Ship on the 23rd.</p>",
        "message": "Push the date back a day",
        "mode": "suggestion"
      }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{
  "revision": {
    "id": "rev_b70c25e1-4a8f-4d93-8b26-51f7c0a9de34",
    "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "rev": 14,
    "checksum": "6f1b9c0e…",
    "parentRev": 13,
    "status": "open",
    "message": "Push the date back a day",
    "createdAt": "2026-08-17T10:15:00.000Z",
    "createdBy": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE"
  }
}
```

### `GET /spaces/:spaceId/documents/:documentId/access`

- **Auth**: session; `editor` on the document — seeing who a document is shared with
  takes the same role as changing it.
- **Behavior**: collects every grant that reaches the document — on the document, on the
  document tree of this page or any ancestor, on the page's category, or on the space —
  and resolves each grantee's role the way `hasPermission` does: the strongest grant
  wins, so a narrower one never reads as a downgrade. `via` is the winning grant;
  `grants` lists them all. Group grants are returned as the group, not expanded into
  its members.
- **Returns**: `200 { access: Array<{ userId?, groupId?, permission, via, grants }> }`,
  where each grant is `{ resourceType, resourceId, inherited, resourceLabel?,
  permission, createdAt }`. `inherited` is false only for a grant on this document
  itself; `resourceLabel` is the ancestor page title or category name.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/access"
```

```json
{
  "access": [
    {
      "userId": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE",
      "permission": "editor",
      "via": {
        "resourceType": "document",
        "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
        "inherited": false,
        "permission": "editor",
        "createdAt": "2026-08-17T09:11:07.000Z"
      },
      "grants": [
        {
          "resourceType": "document",
          "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
          "inherited": false,
          "permission": "editor",
          "createdAt": "2026-08-17T09:11:07.000Z"
        },
        {
          "resourceType": "category",
          "resourceId": "category_a3f70c11-58d9-4e62-8b17-0c95d2fa6e83",
          "inherited": true,
          "resourceLabel": "Handbook",
          "permission": "viewer",
          "createdAt": "2026-04-01T08:00:00.000Z"
        }
      ]
    }
  ]
}
```

### `GET /spaces/:spaceId/documents/:documentId/children`

- **Auth**: session; `viewer` on the document.
- **Behavior**: children are filtered against the caller's document grants, so a child
  with no ACL entry of its own is not enumerable through a grant on the parent alone.
- **Returns**: `200 { children }`.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/children"
```

```json
{
  "children": [
    {
      "id": "doc_9a71fe30-4c28-4d17-8b6e-05f2a7c91d84",
      "slug": "launch-checklist",
      "properties": { "title": "Launch checklist" },
      "parentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "updatedAt": "2026-08-16T18:02:00.000Z"
    }
  ]
}
```

### `GET /spaces/:spaceId/documents/:documentId/breadcrumbs`

- **Auth**: session or public; `viewer` on the space.
- **Returns**: `200 { breadcrumbs }` — ancestor chain for the document.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/documents/doc_9a71fe30-4c28-4d17-8b6e-05f2a7c91d84/breadcrumbs"
```

```json
{
  "breadcrumbs": [
    { "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31", "slug": "launch-plan", "title": "Launch plan" }
  ]
}
```

### `GET /spaces/:spaceId/documents/:documentId/contributors`

- **Auth**: session; `viewer` on the document.
- **Behavior**: derived from the document's audit log events matching
  `DOCUMENT_CONTRIBUTION_AUDIT_EVENTS`, deduplicated by user.
- **Returns**: `200 { contributors: Array<{ userId, name, image }> }` — no email; the
  client renders a name and an id-seeded avatar.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/contributors"
```

```json
{
  "contributors": [
    { "userId": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0", "name": "Ada Lovelace", "image": null }
  ]
}
```

### `GET /spaces/:spaceId/documents/:documentId/diff`

- **Auth**: session / access token / job token / public; `viewer` on the document, plus
  the `?rev=` revision rule above for both sides of the comparison.
- **Query**: `rev` (int ≥1, required), `base?` (int ≥1 — defaults to the revision this
  one was meant to change: its parent for a suggestion, else the document's published
  revision), `format` (`"html"` for an inline `<ins>`/`<del>` redline; default a unified
  diff patch via the `diff` package).
- **Returns**: `200` `text/plain` unified patch, or `text/plain` inline HTML redline.
  Either way the resolved base comes back in `X-Diff-Base-Rev`, so a caller that took
  the default can name both sides. `400` if no comparable base revision/content exists.

```bash
curl -sS -D - -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/diff?rev=14"
```

```diff
Index: doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31
===================================================================
--- doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31
+++ doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31
@@ -1,3 +1,3 @@
 <h1>Launch plan</h1>
-<p>Ship on the 22nd.</p>
+<p>Ship on the 23rd.</p>
```

### `POST /spaces/:spaceId/documents/:documentId/edit`

- **Auth**: session, access token or job token; `editor` on this document.
- **Body**: `{ operations: <edit-operation spec> }` — parsed/validated by
  `parseEditOperations`.
- **Behavior**: readonly documents always reject with `403`. Applies the operations
  to the live collaboration document (Yjs room) if open, so it merges with
  concurrent edits instead of overwriting; falls back to the stored content
  otherwise. The result is sanitized.
- **Returns**: `200 { document, live: boolean }` (`live` indicates whether the edit
  was applied to an open collab room). `400` for invalid operations.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "operations": [{ "type": "replace", "find": "Ship on the 22nd.", "replace": "Ship on the 23rd." }] }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/edit"
```

```json
{
  "document": {
    "id": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "slug": "launch-plan",
    "currentRev": 13,
    "updatedAt": "2026-08-17T10:22:03.000Z"
  },
  "live": true
}
```

### `GET /spaces/:spaceId/documents/:documentId/revisions`

- **Auth**: session; `viewer` on the document plus the `view_history` feature — a
  listing names no revision, so it gets no published-snapshot exemption.
- **Returns**: `200 { revisions }` (metadata list, no content bodies).

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/revisions"
```

```json
{
  "revisions": [
    {
      "id": "rev_b70c25e1-4a8f-4d93-8b26-51f7c0a9de34",
      "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "rev": 14,
      "checksum": "6f1b9c0e…",
      "parentRev": 13,
      "status": "open",
      "message": "Push the date back a day",
      "createdAt": "2026-08-17T10:15:00.000Z",
      "createdBy": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE"
    }
  ]
}
```

### `POST /spaces/:spaceId/documents/:documentId/revisions`

Restores a revision as the new current one.

- **Auth**: session; `editor` on the document.
- **Query**: `rev` (int ≥1, required).
- **Body**: `{ message?: string }` (optional; an empty body is fine).
- **Returns**: `200 { revision }`. `404` if the revision is missing.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "message": "Roll back the date change" }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/revisions?rev=12"
```

```json
{
  "revision": {
    "id": "rev_37f9a4c8-6b21-4e05-9d8a-2c14b7e0f593",
    "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
    "rev": 15,
    "checksum": "0ab72f5d…",
    "parentRev": 14,
    "status": null,
    "message": "Roll back the date change",
    "createdAt": "2026-08-17T10:30:00.000Z",
    "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
  }
}
```

### `PATCH /spaces/:spaceId/documents/:documentId/revisions`

Updates a suggestion's status.

- **Auth**: session; `editor` on the document.
- **Query**: `rev` (int ≥1, required).
- **Body**: `{ status: "open" | "applied" | "dismissed" }`. The target revision must
  be a suggestion (non-null `status`) — else `400`.
- **Returns**: `200 { revision }`. `404` if the revision is missing.

```bash
curl -sS -X PATCH -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "status": "applied" }' \
  "$VEKTOR/spaces/$SPACE/documents/doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31/revisions?rev=14"
```

```json
{
  "revision": {
    "id": "rev_b70c25e1-4a8f-4d93-8b26-51f7c0a9de34",
    "rev": 14,
    "status": "applied",
    "parentRev": 13
  }
}
```

## Comments

### `GET /spaces/:spaceId/comments`

- **Auth**: `viewer` on the document, whichever credential carries it — a public reader,
  an access token and a job token included.
- **Query**: `documentId` (required).
- **Returns**: `200 { comments }` — each enriched with `createdByUser: {id, name,
  image} | null`. No email: the client renders a name and an id-seeded avatar.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/comments?documentId=doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{
  "comments": [
    {
      "id": "comment_8b41c2f9-5d07-4a63-b91e-27c0f6a45de8",
      "parentId": null,
      "type": "text",
      "content": "Should this mention the freeze?",
      "reference": "block-4f2c",
      "resourceType": "document",
      "resourceId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
      "archived": false,
      "createdAt": "2026-08-16T16:40:00.000Z",
      "updatedAt": "2026-08-16T16:40:00.000Z",
      "createdBy": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE",
      "createdByUser": {
        "id": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE",
        "name": "Grace Hopper",
        "image": null
      }
    }
  ]
}
```

### `POST /spaces/:spaceId/comments`

- **Auth**: session; `viewer` on the document + the `comment` feature on it.
- **Body**: `documentId` (string, required), `content` (string, required),
  `parentId?` (string), `type?` (string), `reference?` (string — required for
  top-level/non-reply comments).
- **Behavior**: audit-logged; enqueues "comment created" email notifications, and
  a "mentioned you" one for each user the comment mentions; broadcasts a
  `comment_created` realtime event.
- **Returns**: `200 { comment }`.

```bash
curl -sS -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
        "content": "Should this mention the freeze?",
        "reference": "block-4f2c"
      }' \
  "$VEKTOR/spaces/$SPACE/comments"
```

```json
{
  "comment": {
    "id": "comment_8b41c2f9-5d07-4a63-b91e-27c0f6a45de8",
    "parentId": null,
    "type": "text",
    "content": "Should this mention the freeze?",
    "reference": "block-4f2c",
    "archived": false,
    "createdAt": "2026-08-16T16:40:00.000Z",
    "createdBy": "Lm4pQ8rT2vX6zB0dF3hJ7kN9sW1yA5cE"
  }
}
```

### `PATCH /spaces/:spaceId/comments`

- **Auth**: session; `viewer` on the document + the `comment` feature. `editor` on the
  document may maintain any thread; anyone else may only touch their own comments
  (`403` otherwise), matching DELETE's authorship rule.
- **Body**: `documentId` (string, required), `commentIds: string[]` (required,
  non-empty), and either `archived: true` (archive them; broadcasts `comment_deleted`)
  or `reference: string` (re-point them; broadcasts `comment_updated`).
- **Behavior**: an id outside this document rejects the whole request — this is a bulk
  thread operation, so silently dropping ids would leave a thread half-archived.
- **Returns**: `200 { success: true }`. `404` if any id does not belong to the document.

```bash
curl -sS -X PATCH -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31",
        "commentIds": ["comment_8b41c2f9-5d07-4a63-b91e-27c0f6a45de8"],
        "archived": true
      }' \
  "$VEKTOR/spaces/$SPACE/comments"
```

```json
{ "success": true }
```

### `DELETE /spaces/:spaceId/comments`

- **Auth**: session; `viewer` on the document + the `comment` feature. Caller must be
  the comment's creator (else `403`).
- **Body**: `{ commentId: string, documentId: string }`.
- **Behavior**: the lookup is scoped to `documentId`, so a bare id cannot reach a
  comment on another document. Broadcasts `comment_deleted`.
- **Returns**: `200 { success: true }`. `404` if the comment is missing.

```bash
curl -sS -X DELETE -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{
        "commentId": "comment_8b41c2f9-5d07-4a63-b91e-27c0f6a45de8",
        "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
      }' \
  "$VEKTOR/spaces/$SPACE/comments"
```

```json
{ "success": true }
```

## Notifications

### `GET /spaces/:spaceId/notification-preference`

- **Auth**: session; `viewer` on the document when `documentId` is given, else on the
  space.
- **Query**: `documentId?` — read the per-document override instead of the
  space-wide default.
- **Behavior**: a per-document mute overrides the space-wide default; if neither
  is set, notifications are not muted.
- **Returns**: `200 { muted: boolean }`.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/notification-preference?documentId=doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31"
```

```json
{ "muted": false }
```

### `PATCH /spaces/:spaceId/notification-preference`

- **Auth**: session; `viewer` on the document when `documentId` is given, else on the
  space.
- **Body**: `{ muted: boolean, documentId?: string }` — sets the per-document
  override when `documentId` is given, otherwise the space-wide default.
- **Returns**: `200 { muted }`.

```bash
curl -sS -X PATCH -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "muted": true, "documentId": "doc_c58a1d70-3e42-4b9f-8a16-2f7d0c9b5e31" }' \
  "$VEKTOR/spaces/$SPACE/notification-preference"
```

```json
{ "muted": true }
```

## Extensions

### `GET /spaces/:spaceId/extensions`

- **Auth**: session, access token or job token; `editor` role. A job token sees every
  extension in the space; a user session sees only the ones they can access
  (editor-on-space or an explicit extension ACL grant).
- **Returns**: `200 { extensions, errors }` — disabled extensions included; `errors`
  carries the manifests that failed to parse.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$VEKTOR/spaces/$SPACE/extensions"
```

```json
{
  "extensions": [
    {
      "id": "acme.release-notes",
      "name": "Release notes",
      "version": "1.4.0",
      "description": "Turns closed issues into a release-notes document.",
      "enabled": true,
      "source": "upload",
      "sourceRef": null,
      "sourcePublisher": null,
      "entries": [{ "id": "panel", "type": "panel", "entry": "ui/panel.js" }],
      "routes": [],
      "jobs": [{ "id": "release-notes", "entry": "jobs/release-notes.js" }],
      "createdAt": "2026-05-02T09:00:00.000Z",
      "updatedAt": "2026-08-01T11:12:00.000Z",
      "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
    }
  ],
  "errors": []
}
```

### `POST /spaces/:spaceId/extensions`

Installs a new extension, or updates one already installed under the same manifest id.

- **Auth**: the space-wide `manage_extensions` capability, whichever credential carries
  it — a session, an access token granted that feature, or a job token with a user id
  that holds it. Anonymous job tokens are refused outright: the uploaded code runs in
  every member's browser. Authorization happens before the body is read, so an
  unauthorized caller never makes the server unzip an archive.
- **Body**: multipart form — `file` (a `.zip`, ≤5MB, required; must contain
  `manifest.json`).
- **Behavior**: the extension id comes from the manifest (`manifest.id`); if it already
  exists in the space, the upload updates it in place instead of creating a new one.
  The server-wide extension-source policy must allow `"upload"` (else `403`).
- **Returns**: `201` extension metadata (same shape as the list entries). `400` for an
  invalid zip/manifest or an oversize file; `403` if uploads are disabled by policy.

```bash
curl -sS -b "$COOKIE" -F "file=@release-notes-1.4.0.zip" \
  "$VEKTOR/spaces/$SPACE/extensions"
```

```json
{
  "id": "acme.release-notes",
  "name": "Release notes",
  "version": "1.4.0",
  "enabled": true,
  "source": "upload",
  "jobs": [{ "id": "release-notes", "entry": "jobs/release-notes.js" }],
  "createdAt": "2026-05-02T09:00:00.000Z",
  "updatedAt": "2026-08-17T10:45:00.000Z",
  "createdBy": "KJ8vQ2mNpR4tL6wX9yZ1aB3cD5eF7gH0"
}
```

### `GET /spaces/:spaceId/extensions/:extensionId`

- **Auth**: session, access token or job token; `editor` on the space, and for a user
  session also `viewer` on this extension.
- **Returns**: `200` extension metadata object. `404` if missing.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$VEKTOR/spaces/$SPACE/extensions/acme.release-notes"
```

### `PATCH /spaces/:spaceId/extensions/:extensionId`

Enables or disables an extension.

- **Auth**: session; the `manage_extensions` feature.
- **Body**: `{ enabled: boolean }`.
- **Returns**: `200` updated extension metadata. `400` if `enabled` isn't boolean;
  `404` if missing.

```bash
curl -sS -X PATCH -b "$COOKIE" -H "Content-Type: application/json" \
  -d '{ "enabled": false }' \
  "$VEKTOR/spaces/$SPACE/extensions/acme.release-notes"
```

```json
{
  "id": "acme.release-notes",
  "name": "Release notes",
  "version": "1.4.0",
  "enabled": false,
  "updatedAt": "2026-08-17T10:47:31.000Z"
}
```

### `DELETE /spaces/:spaceId/extensions/:extensionId`

- **Auth**: session; the `manage_extensions` feature.
- **Returns**: `200 { success: true }`. `404` if missing.

```bash
curl -sS -X DELETE -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/extensions/acme.release-notes"
```

```json
{ "success": true }
```

### `GET /spaces/:spaceId/extensions/:extensionId/package`

- **Auth**: session; the `manage_extensions` feature.
- **Behavior**: downloads the raw extension ZIP — for debugging broken packages.
- **Returns**: `200` `application/zip` binary with a `Content-Disposition`
  attachment header. `404` if missing.

```bash
curl -sS -b "$COOKIE" -O -J \
  "$VEKTOR/spaces/$SPACE/extensions/acme.release-notes/package"
```

### `GET /spaces/:spaceId/extensions/:extensionId/assets/*path`

- **Auth**: session; `viewer` on this extension (editor-on-space or an explicit
  extension grant).
- **Behavior**: extracts the requested file on-demand from the stored extension
  ZIP. `.js`/`.mjs`/`.css` responses omit CSP entirely (a CSP header on a module
  script response hangs Chrome's `import()`); other asset types get a restrictive
  asset CSP. 1-hour cache.
- **Returns**: `200` file bytes with a MIME type inferred from the extension. `404` if
  extension/asset is missing.

```bash
curl -sS -b "$COOKIE" \
  "$VEKTOR/spaces/$SPACE/extensions/acme.release-notes/assets/ui/panel.js"
```
