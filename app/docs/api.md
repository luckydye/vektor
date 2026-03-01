# API v1

Base path: `/api/v1`

## Auth

- Session auth: normal logged-in user session (`context.locals.user`).
- Access token auth: `Authorization: Bearer at_...` (or raw `at_...`) on endpoints that call `authenticateRequest`.
- Job auth: `X-Job-Token` (and sometimes `X-Space-Id`) on job-enabled endpoints.
- If auth is missing/invalid: `401`.
- If auth is valid but permission is insufficient: `403`.

## Error format

Most errors are JSON:

```json
{ "error": "message" }
```

## Quick Summary

| Method | Path | What it does |
|---|---|---|
| GET | `/url-metadata` | Returns link preview metadata for internal docs or external URLs. |
| POST | `/chat/completions` | Proxies chat-completion requests to OpenRouter with a fixed model. |
| GET | `/users` | Lists users or fetches a single user by `id` query param. |
| GET | `/users/me` | Returns the current authenticated user profile. |
| GET | `/spaces` | Lists spaces the current user can access. |
| POST | `/spaces` | Creates a new space. |
| GET | `/spaces/:spaceId` | Returns one space by ID. |
| PATCH | `/spaces/:spaceId` | Updates space name/slug/preferences with role-based restrictions. |
| DELETE | `/spaces/:spaceId` | Deletes a space (owner only). |
| GET | `/spaces/:spaceId/members` | Lists space members including direct and group-derived permissions. |
| GET | `/spaces/:spaceId/properties` | Lists all document properties and observed values in a space. |
| GET | `/spaces/:spaceId/audit-logs` | Returns recent space-level audit logs. |
| POST | `/spaces/:spaceId/import` | Imports WIF `.zip` content (docs/categories/media) into a space. |
| GET | `/spaces/:spaceId/categories` | Lists categories in a space. |
| POST | `/spaces/:spaceId/categories` | Creates a category. |
| PUT | `/spaces/:spaceId/categories` | Reorders categories by ID list. |
| GET | `/spaces/:spaceId/categories/:id` | Returns a single category. |
| PUT | `/spaces/:spaceId/categories/:id` | Updates a category. |
| DELETE | `/spaces/:spaceId/categories/:id` | Deletes a category. |
| GET | `/spaces/:spaceId/permissions` | Lists role and/or feature permissions. |
| POST | `/spaces/:spaceId/permissions` | Grants/denies/revokes role or feature permissions. |
| GET | `/spaces/:spaceId/permissions/me` | Returns caller’s effective role/features/groups in the space. |
| GET | `/spaces/:spaceId/search` | Searches documents with optional pagination and property filters. |
| POST | `/spaces/:spaceId/search/rebuild` | Rebuilds the space search index. |
| GET | `/spaces/:spaceId/uploads` | Lists uploaded files in a space. |
| POST | `/spaces/:spaceId/uploads` | Uploads a file and returns its API URL/key. |
| GET | `/spaces/:spaceId/uploads/*` | Serves an uploaded file by path. |
| GET | `/spaces/:spaceId/webhooks` | Lists webhooks. |
| POST | `/spaces/:spaceId/webhooks` | Creates a webhook. |
| GET | `/spaces/:spaceId/webhooks/:webhookId` | Returns one webhook. |
| PATCH | `/spaces/:spaceId/webhooks/:webhookId` | Updates webhook fields/events/status. |
| DELETE | `/spaces/:spaceId/webhooks/:webhookId` | Deletes a webhook. |
| GET | `/spaces/:spaceId/access-tokens` | Lists access tokens and their resource grants. |
| POST | `/spaces/:spaceId/access-tokens` | Creates an access token and grants initial resource permission. |
| GET | `/spaces/:spaceId/access-tokens/:tokenId` | Returns one token with resource grants. |
| PATCH | `/spaces/:spaceId/access-tokens/:tokenId` | Revokes an access token (soft delete). |
| DELETE | `/spaces/:spaceId/access-tokens/:tokenId` | Permanently deletes an access token. |
| PUT | `/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId` | Grants token access to a specific resource. |
| DELETE | `/spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId` | Revokes token access to a specific resource. |
| POST | `/spaces/:spaceId/jobs/run` | Runs an extension job inline or as SSE stream. |
| GET | `/spaces/:spaceId/workflows/runs` | Lists active runs or latest run for a document. |
| POST | `/spaces/:spaceId/workflows/runs` | Starts a workflow run asynchronously. |
| GET | `/spaces/:spaceId/workflows/runs/:runId` | Returns status and node state for one run. |
| DELETE | `/spaces/:spaceId/workflows/runs/:runId` | Cancels a run. |
| GET | `/spaces/:spaceId/documents` | Lists documents (optionally by categories). |
| POST | `/spaces/:spaceId/documents` | Creates a document from JSON or raw content. |
| GET | `/spaces/:spaceId/documents/archived` | Lists archived documents visible to the caller. |
| GET | `/spaces/:spaceId/documents/:documentId` | Returns current document or a specific revision (`?rev=`). |
| PUT | `/spaces/:spaceId/documents/:documentId` | Replaces document content or restores archived doc. |
| PATCH | `/spaces/:spaceId/documents/:documentId` | Patches properties/parent/published revision/readonly state. |
| DELETE | `/spaces/:spaceId/documents/:documentId` | Archives or permanently deletes a document. |
| POST | `/spaces/:spaceId/documents/:documentId` | Creates a new revision snapshot for a document. |
| GET | `/spaces/:spaceId/documents/:documentId/children` | Lists direct child documents. |
| GET | `/spaces/:spaceId/documents/:documentId/contributors` | Lists users who appear in the document audit history. |
| GET | `/spaces/:spaceId/documents/:documentId/comments` | Lists comments on a document. |
| POST | `/spaces/:spaceId/documents/:documentId/comments` | Creates a comment/reply on a document. |
| DELETE | `/spaces/:spaceId/documents/:documentId/comments` | Deletes (archives) one of your comments. |
| GET | `/spaces/:spaceId/documents/:documentId/revisions` | Lists revision metadata/history. |
| POST | `/spaces/:spaceId/documents/:documentId/revisions?rev=<n>` | Restores revision `n` as a new revision. |
| GET | `/spaces/:spaceId/documents/:documentId/audit-logs` | Returns document audit logs. |
| GET | `/spaces/:spaceId/documents/:documentId/diff?rev=<n>` | Returns unified diff between revision `n` and published content. |
| GET | `/spaces/:spaceId/extensions` | Lists extensions the user can access. |
| POST | `/spaces/:spaceId/extensions` | Uploads or updates an extension package (`.zip`). |
| GET | `/spaces/:spaceId/extensions/:extensionId` | Returns extension metadata. |
| DELETE | `/spaces/:spaceId/extensions/:extensionId` | Deletes an extension. |
| GET | `/spaces/:spaceId/extensions/:extensionId/assets/*` | Serves extension asset files from package zip. |
| POST | `/spaces/:spaceId/extensions/:extensionId/data-sources/:dataSourceId/query` | Runs a data-source job and returns outputs/logs. |

---

## `GET /url-metadata`

- Query:
- `url` (required)
- Behavior:
- Internal URL (same host): resolves wiki doc metadata, checks doc access.
- External URL: fetches HTML and extracts OG/title/description/image/favicon.
- Returns:
- `200` with:

```json
{
  "url": "https://...",
  "title": "string|null",
  "description": "string|null",
  "image": "string|null",
  "siteName": "string|null",
  "favicon": "string|null",
  "updatedAt": "string|null",
  "fetchedAt": 0
}
```

---

## `POST /chat/completions`

- Auth:
- User session OR job headers `X-Job-Token` + `X-Space-Id`.
- Body:
- Proxied JSON payload for OpenRouter chat completions.
- Server forces `model = "openai/gpt-oss-120b"`.
- Returns:
- Proxied upstream status/body (supports streaming).

---

## `GET /users`

- Auth: session.
- Query:
- Optional `id`.
- Returns:
- `200` single user when `id` provided, else list of users.

## `GET /users/me`

- Auth: session.
- Returns:
- `200` current user `{ id, name, email, image }`.

---

## `GET /spaces`

- Auth: session.
- Returns:
- `200` list of spaces for current user.

## `POST /spaces`

- Auth: session.
- Body:
- `name` (required)
- `slug` (required)
- `preferences` (optional object)
- Returns:
- `201` `{ space }`.

---

## `GET /spaces/:spaceId`

- Auth: session + `viewer` role.
- Returns: `200` `{ space }`.

## `PATCH /spaces/:spaceId`

- Auth:
- `owner` if changing `name`/`slug`.
- `editor` if only changing `preferences`.
- Body:
- Any of `name`, `slug`, `preferences`.
- Returns: `200` updated space object.

## `DELETE /spaces/:spaceId`

- Auth: session + `owner`.
- Returns: `200` success.

---

## `GET /spaces/:spaceId/members`

- Auth: session + `viewer`.
- Returns:
- `200` list of members from direct ACL + group ACL expansion.

## `GET /spaces/:spaceId/properties`

- Auth: session + `viewer`.
- Returns:
- `200` `{ properties: PropertyInfo[] }`.

## `GET /spaces/:spaceId/audit-logs`

- Auth: session + space access + `VIEW_AUDIT` feature.
- Query:
- `limit` (default `100`, min `1`, max `1000`)
- Returns:
- `200` `{ auditLogs }`.

## `POST /spaces/:spaceId/import`

- Auth: session + `editor`.
- Body:
- `multipart/form-data` with `file` (`.zip`, max 100MB, WIF format).
- Behavior:
- Imports categories, documents, media; resolves slug collisions and parent links.
- Returns:
- `200` import summary:
- counts (`totalFiles`, `imported`, `skipped`, `failed`)
- `documents`, `categories`, `errors`.

---

## `GET /spaces/:spaceId/categories`

- Auth: session + `viewer`.
- Returns:
- `200` `{ categories }`.

## `POST /spaces/:spaceId/categories`

- Auth: session + `editor`.
- Body:
- `name` (required), `slug` (required), optional `description`, `color`, `icon`.
- Returns:
- `201` `{ category }`.

## `PUT /spaces/:spaceId/categories`

- Auth: session + `editor`.
- Body:
- `categoryIds` (required non-empty array).
- Returns:
- `200` `{ success: true }`.

## `GET /spaces/:spaceId/categories/:id`

- Auth: session + `viewer`.
- Returns: `200` `{ category }`.

## `PUT /spaces/:spaceId/categories/:id`

- Auth: session + `editor`.
- Body:
- `name` + `slug` required, optional `description`, `color`, `icon`.
- Returns: `200` `{ category }`.

## `DELETE /spaces/:spaceId/categories/:id`

- Auth: session + `editor`.
- Returns: `200` success.

---

## `GET /spaces/:spaceId/permissions`

- Auth: session + `owner`.
- Query:
- `type=role|feature|all` (default `all`)
- `resourceType` (default `space`)
- `resourceId` (default `:spaceId`)
- Returns:
- `200` `{ permissions: [{ type, permission }] }`.

## `POST /spaces/:spaceId/permissions`

- Auth: session + `owner`.
- Body:
- `type`: `"role"` or `"feature"`
- `roleOrFeature`: role name or feature name
- `action`: `"grant" | "deny" | "revoke"`
- target: `userId` or `groupId` (at least one required)
- optional `resourceType`, `resourceId` for role permissions
- Returns:
- `200` updated permission payload or `{ success: true }`.

## `GET /spaces/:spaceId/permissions/me`

- Auth: session + space access.
- Returns:
- `200` `{ role, features, groups }`.

---

## `GET /spaces/:spaceId/search`

- Auth:
- Session `viewer` OR valid `X-Job-Token`.
- Query:
- `q` (string; can be empty only when filters exist)
- `limit` (default `20`, max `100`)
- `offset` (default `0`)
- `filters` (JSON string array: `{ key: string, value: string|null }[]`)
- Returns:
- `200` `{ results, total, query, limit, offset, filters }`.

## `POST /spaces/:spaceId/search/rebuild`

- Auth: session + `owner`.
- Returns: `200` success message.

---

## `GET /spaces/:spaceId/uploads`

- Auth: session + `viewer`.
- Returns:
- `200` `{ files: [{ key, url, size, updatedAt }] }`.

## `POST /spaces/:spaceId/uploads`

- Auth:
- Session `editor` OR valid `X-Job-Token`.
- Body:
- `multipart/form-data` with:
- `file` (required)
- `filename` (optional)
- `documentId` (optional)
- Rules:
- Max 50MB.
- User auth: allowlist file types/extensions enforced.
- Job auth: type allowlist bypassed.
- Returns:
- `200` `{ url, key }`.

## `GET /spaces/:spaceId/uploads/*`

- Auth:
- Session `viewer` OR valid `X-Job-Token`.
- Params:
- `path` required.
- Returns:
- Raw file bytes with inferred MIME type and long cache headers.

---

## `GET /spaces/:spaceId/webhooks`

- Auth: session + `viewer`.
- Returns:
- `200` `{ webhooks }`.

## `POST /spaces/:spaceId/webhooks`

- Auth: session + `admin`.
- Body:
- `url` (required string)
- `events` (required non-empty array; validated)
- optional `documentId`, `secret`
- Returns:
- `200` `{ webhook }`.

## `GET /spaces/:spaceId/webhooks/:webhookId`

- Auth: session + `viewer`.
- Returns:
- `200` `{ webhook }`.

## `PATCH /spaces/:spaceId/webhooks/:webhookId`

- Auth: session + `admin`.
- Body:
- Any of `url`, `events`, `documentId`, `secret`, `enabled` with strict type checks.
- Returns:
- `200` `{ webhook }`.

## `DELETE /spaces/:spaceId/webhooks/:webhookId`

- Auth: session + `admin`.
- Returns:
- `200` `{ success: true }`.

---

## `GET /spaces/:spaceId/access-tokens`

- Auth: session + `editor`.
- Returns:
- `200` `{ tokens }` including each token's resources.

## `POST /spaces/:spaceId/access-tokens`

- Auth: session + `editor`.
- Body:
- `name` (required string)
- `resourceType` (required; enum)
- `resourceId` (required string)
- `permission` (required: `viewer | editor | extensions`)
- `expiresInDays` (optional positive number)
- Returns:
- `201` with one-time plaintext token:
- `{ id, token, resources, message }`

## `GET /spaces/:spaceId/access-tokens/:tokenId`

- Auth: session + `editor`.
- Returns:
- `200` `{ token }` with resources.

## `PATCH /spaces/:spaceId/access-tokens/:tokenId`

- Auth: session + `editor`.
- Behavior:
- Revokes token (soft delete).
- Returns:
- `200` success message.

## `DELETE /spaces/:spaceId/access-tokens/:tokenId`

- Auth: session + `editor`.
- Behavior:
- Permanently deletes token.
- Returns:
- `200` success message.

## `PUT /spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId`

- Auth: session + `editor`.
- Body:
- `permission` required: `viewer | editor`.
- Returns:
- `200` `{ resources, message }`.

## `DELETE /spaces/:spaceId/access-tokens/:tokenId/resources/:resourceType/:resourceId`

- Auth: session + `editor`.
- Returns:
- `200` success message.

---

## `POST /spaces/:spaceId/jobs/run`

- Auth:
- Session `editor` OR valid `X-Job-Token`.
- Body:
- `jobId` (required)
- `inputs` (optional object)
- `stream` (optional boolean)
- Behavior:
- Resolves `jobId` across extension manifests and runs it.
- Returns:
- Normal mode: `200` `{ outputs, logs }`
- Streaming mode (`stream=true`): `text/event-stream` events:
- `{ type: "log", message }`
- `{ type: "output", outputs }`
- `{ type: "error", error }`
- `[DONE]`

---

## `GET /spaces/:spaceId/workflows/runs`

- Auth: session + `viewer`.
- Query:
- optional `documentId`.
- Returns:
- with `documentId`: latest run summary `{ runId, status }` (or `404`)
- without `documentId`: active run list `{ runs: [...] }`

## `POST /spaces/:spaceId/workflows/runs`

- Auth: session + `editor`.
- Body:
- `documentId` (required; must be workflow doc)
- optional restart controls: `fromRunId`, `fromNodeId`
- Returns:
- `202` `{ runId }` (execution continues in background).

## `GET /spaces/:spaceId/workflows/runs/:runId`

- Auth: session + `viewer`.
- Returns:
- `200` `{ status, nodes }` with node inputs/outputs/logs/timestamps.

## `DELETE /spaces/:spaceId/workflows/runs/:runId`

- Auth: session + `editor`.
- Behavior:
- Cancels run.
- Returns:
- `200` `{ ok: true }`.

---

## `GET /spaces/:spaceId/documents`

- Auth:
- Session OR access token.
- Permission:
- User: space `viewer`.
- Token: space `viewer` on resource `(space, :spaceId)`.
- Query:
- `limit` (default `100`, max `1000`)
- `offset` (default `0`)
- `categorySlugs` (comma-separated)
- `grouped=true|false` (only relevant with `categorySlugs`)
- Returns:
- `200` list/paginated docs or grouped docs-by-category.

## `POST /spaces/:spaceId/documents`

- Auth: session + `editor`.
- Body:
- JSON:
- `content` required string
- optional `properties`, `parentId`, `type`
- OR raw text/markdown/html body (converted if markdown)
- Returns:
- `201` `{ document }`.

## `GET /spaces/:spaceId/documents/archived`

- Auth: session + space access.
- Returns:
- `200` `{ documents }`.

## `GET /spaces/:spaceId/documents/:documentId`

- Auth:
- Valid `X-Job-Token` OR session/access token.
- Permission:
- user/token needs document `viewer`.
- Query:
- optional `rev` (positive integer) to fetch specific revision content+metadata.
- Returns:
- `200` `{ document }` or `{ revision }`.

## `PUT /spaces/:spaceId/documents/:documentId`

- Auth:
- Valid `X-Job-Token` OR session/access token.
- Permission:
- editor on document for user/token path.
- Body:
- JSON mode:
- `content` string to replace doc content
- or `restore: true` (user/token path only, no `content`) to unarchive document
- Non-JSON mode:
- raw text/markdown/html content
- Notes:
- blocked for readonly docs (except restore flow).
- content is sanitized (script tags removed).
- Returns:
- `200` `{ document }` or `{ success: true }` for restore.

## `PATCH /spaces/:spaceId/documents/:documentId`

- Auth: session + document `editor`.
- Body supports:
- Properties patch:
- `{ properties: { [key]: value|null|{value,type?} } }`
- cannot combine with `parentId`, `publishedRev`, `readonly`
- Parent patch:
- `{ parentId: string|null }`
- Publish patch:
- `{ publishedRev: number|null }`
- Readonly patch:
- `{ readonly: boolean }`
- Returns:
- `200` success payload.

## `DELETE /spaces/:spaceId/documents/:documentId`

- Auth: session.
- Query:
- `permanent=true|false` (default false)
- Permission:
- permanent delete requires `owner`
- archive requires `editor`
- Returns:
- `200` success.

## `POST /spaces/:spaceId/documents/:documentId`

- Auth: session + document access.
- Body:
- JSON: `html` required string, optional `message`
- or raw text/markdown/html body
- Creates new revision.
- Returns:
- `200` `{ revision }`.

## `GET /spaces/:spaceId/documents/:documentId/children`

- Auth: session + document access.
- Returns:
- `200` `{ children }`.

## `GET /spaces/:spaceId/documents/:documentId/contributors`

- Auth: session + document access.
- Returns:
- `200` `{ contributors }` from audit history user IDs.

## `GET /spaces/:spaceId/documents/:documentId/comments`

- Auth:
- Optional session; public-doc viewers can read.
- Returns:
- `200` `{ comments }` enriched with `createdByUser`.

## `POST /spaces/:spaceId/documents/:documentId/comments`

- Auth: session + document access + `COMMENT` feature.
- Body:
- `content` required
- optional `parentId`, `type`, `reference`
- Returns:
- `200` `{ comment }`.

## `DELETE /spaces/:spaceId/documents/:documentId/comments`

- Auth: session + document access.
- Body:
- `commentId` required.
- Rule:
- only comment creator can delete.
- Returns:
- `200` `{ success: true }`.

## `GET /spaces/:spaceId/documents/:documentId/revisions`

- Auth: session + document access + `VIEW_HISTORY` feature.
- Returns:
- `200` `{ revisions }`.

## `POST /spaces/:spaceId/documents/:documentId/revisions?rev=<n>`

- Auth: session + document `editor`.
- Query:
- `rev` required positive integer.
- Body:
- optional `{ message }`.
- Behavior:
- restores revision and creates a new revision entry.
- Returns:
- `200` `{ revision }`.

## `GET /spaces/:spaceId/documents/:documentId/audit-logs`

- Auth: session + document access + `VIEW_AUDIT` feature.
- Query:
- `limit` (default `100`, min `1`, max `1000`)
- Returns:
- `200` `{ auditLogs }`.

## `GET /spaces/:spaceId/documents/:documentId/diff?rev=<n>`

- Auth: session OR access token with document `viewer`.
- Query:
- `rev` required positive integer.
- Behavior:
- creates unified diff between revision `rev` and current published content.
- Returns:
- `200` plain text patch.

---

## `GET /spaces/:spaceId/extensions`

- Auth: session.
- Access:
- returns only extensions user can access (space editor or explicit extension ACL).
- Returns:
- `200` extension metadata list.

## `POST /spaces/:spaceId/extensions`

- Auth:
- Session (must be space owner) OR access token with `extensions` permission on space.
- Body:
- `multipart/form-data` with zip `file` (required, max 5MB, must include `manifest.json`).
- Behavior:
- upserts extension by `manifest.id`.
- Returns:
- `201` extension metadata.

## `GET /spaces/:spaceId/extensions/:extensionId`

- Auth: session + extension access.
- Returns:
- `200` extension metadata.

## `DELETE /spaces/:spaceId/extensions/:extensionId`

- Auth: session + space owner.
- Returns:
- `200` success.

## `GET /spaces/:spaceId/extensions/:extensionId/assets/*`

- Auth: session + extension access.
- Returns:
- Raw asset file from extension package zip with inferred MIME type.

## `POST /spaces/:spaceId/extensions/:extensionId/data-sources/:dataSourceId/query`

- Auth: session + extension access.
- Body:
- optional `{ inputs: Record<string, unknown> }`.
- Behavior:
- resolves `dataSourceId` -> job and runs it.
- Returns:
- `200` `{ outputs, logs }`.
