# Security Hardening Progress

Tracking remediation of the API-surface security audit (2026-06-07).

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| H1 | High | `rev/[id].astro` redirect page has no auth → leaks doc slugs/revisions of private spaces | ✅ fixed |
| H2 | High | Webhook delivery follows redirects → SSRF bypass of `isPublicUrl` check | ✅ fixed |
| H3 | High | `Host`/`X-Forwarded-Proto` trusted unconditionally when building request URL | ✅ fixed |
| H4 | High | Auth rate limiting keyed on spoofable `x-forwarded-for` | ✅ fixed |
| M1 | Medium | No CSRF layer beyond SameSite=Lax — add Origin check for unsafe methods | ✅ fixed |
| M2 | Medium | Unbounded request body buffering in API adapter (DoS) | ✅ fixed |
| M3 | Medium | Document list endpoints bypass per-document ACL (metadata leak) | ✅ fixed |
| M4 | Medium | XML injection in CalDAV principal/calendar-list responses | ✅ fixed |
| M5 | Medium | Space editors can read secret values (rest of secrets surface is owner-only) | ✅ fixed |
| L1 | Low | `edit.ts` checks space role but not document role (parity with PATCH/DELETE) | ✅ fixed |
| L2 | Low | `extensions/index.ts` token branch checks invalid permission `"extensions"` | ✅ fixed |
| L3 | Low | Member emails exposed to space viewers (PII) | ✅ fixed |
| L4 | Low | No-auth mode guard keys only on `NODE_ENV=production` | ✅ fixed |
| L5 | Low | `new.astro` lacks member check (leaks space name) | ✅ fixed |
| L6 | Low | `getUserGroups` trusts stored groups; LIKE wildcard over-matching on group names | ✅ fixed |
| L7 | Low | Route params not validated after URL-decoding (`/`, `..`, control chars) | ✅ fixed |

## Log

- **H1** — `src/pages/[spaceSlug]/rev/[id].astro`: now calls `resolveSpacePage` + `requireSpaceViewer` before any DB lookup, mirroring sibling pages.
- **H2** — Promoted `safeFetch` (per-hop SSRF validation, `redirect: "manual"`, max 5 hops) from `agent/commands/curl.ts` into `src/utils/ssrf.ts`; `triggerWebhooks` in `src/db/webhooks.ts` now delivers via `safeFetch`.
- **H3** — `src/api/server/adapter.ts`: request URL is built from the canonical `WIKI_SITE_URL` origin when configured; `X-Forwarded-Proto` is only honored when `WIKI_TRUST_PROXY=1`. `src/server.ts` sets Express `trust proxy` from the same flag.
- **H4** — `buildApiContext` now overwrites `x-forwarded-for` with the socket address (or rightmost trusted-proxy hop when `WIKI_TRUST_PROXY=1`), so better-auth's rate limiter buckets cannot be rotated by spoofed headers.
- **M1** — `src/api/server/router.ts`: unsafe-method requests with an `Origin` header not in the trusted set (and not same-host) are rejected with 403. Explicit CSRF layer on top of SameSite=Lax.
- **M2** — `readRequestBody` caps buffering at 256MB (override: `WIKI_MAX_REQUEST_BYTES`), destroys the connection and returns 413 via `PayloadTooLargeError`.
- **M3** — New `filterReadableResources` in `src/db/acl.ts` mirrors `hasPermission` semantics in bulk (space-role fallback when no doc ACL rows; explicit rows must reach viewer). `listDocuments` / `listAllDocumentsByCategories` take an `AclViewer` and filter before pagination; wired into `GET /documents` (sessions, access tokens via `token:<id>`, job tokens with user context) and the CalDAV REPORT calendar feed. Trusted server job tokens without user context keep the unfiltered view.
- **M4** — Added `escapeXml` to `src/db/caldav.ts`; principal email, space `displayname`, and `brandColor` are now escaped in CalDAV multistatus responses.
- **M5** — `userCanReadSpaceSecret` no longer grants plaintext value reads to space editors; reads now require space owner or an explicit per-secret ACL grant, consistent with the owner-only list/write/delete endpoints. **Behavior change:** editor-initiated jobs reading secrets now need an explicit `SECRET` grant.
- **L1** — `edit.ts` user-session path now also enforces `verifyDocumentRole(..., "editor")` on the document (parity with PATCH/DELETE).
- **L2** — Extension upload token branch now requires `"owner"` (was the invalid `"extensions"`, which failed closed but was a latent escalation if `meetsPermissionLevel` ever regressed).
- **L3** — `members.ts` only includes member `email` when the caller is space owner/editor; plain viewers get id/name/image. (Comment/contributor author emails on visible documents left as-is — flag if those should be gated too.)
- **L4** — `noAuth.ts` now also refuses to start when `WIKI_SITE_URL` points at a non-local host (or is unparseable), so a deployment that forgets `NODE_ENV=production` is still protected.
- **L5** — `new.astro` now calls `requireSpaceViewer`.
- **L6** — `GROUP_NAME_PATTERN` centralized in `src/db/acl.ts`; `getUserGroups` drops malformed stored entries, `grantPermission` rejects invalid group names (prevents LIKE-wildcard over-matching), and the OAuth sanitizer reuses the shared pattern.
- **L7** — `matchRoute` validates decoded params centrally: rejects control chars and `\` everywhere; single-segment params may not contain `/` or be `.`/`..`; catch-all params may not contain `.`/`..` segments.

## Verification

- `tsc --noEmit`: no new errors vs. HEAD (pre-existing errors in `generated/`, Bun typings etc. unchanged).
- Integration suites (acl, permissions, api, caldav, webhooks-audit, document-edit, readonly, job-token-auth, features, frontend-acl, adapter unit tests — 365 tests, AI/embedding suites excluded):
  - **After changes: 336 pass / 27 fail.** Baseline at HEAD: 335 pass / 28 fail.
  - **Zero new failures introduced** — the 27 failures all pre-exist on this branch (failure sets compared name-by-name).
  - One previously failing test now passes: `ACL API Tests - Access Control > should deny document access without permission` (fixed by the M3/L6 ACL work).

## Config centralization

All environment-variable access now goes through `src/config.ts` (no direct `process.env` reads outside it):

- Added keys to `config()`: `NODE_ENV`, `TRUST_PROXY`, `MAX_REQUEST_BYTES`, `API_ONLY`, `SERVER_HOST`, `EMAIL_AUTH`, `REQUIRE_EMAIL_VERIFICATION`, `OAUTH_ALLOWED_GROUPS`, `WORKFLOW_RUN_STORE_FILE`, `CLI_HOST`, `CLI_SPACE_ID`, `CLI_ACCESS_TOKEN`.
- New helpers: `isTrustProxyEnabled()` and `getPublicEnv()` (single source of truth for the browser-exposed env, used by both `middleware.ts` and the Express `adapter.ts` — previously two divergent inline lists).
- Migrated: `api/server/adapter.ts`, `server.ts`, `noAuth.ts`, `auth.ts`, `middleware.ts`, `db/secretsCrypto.ts`, `jobs/runStore.ts`, `cli/{resolve,document,workflow}.ts`.
- Sole remaining `process.env` outside `config.ts` is a *write* in `observability/otel.ts` (`process.env.OTEL_SERVICE_NAME = appConfig.OTEL_SERVICE_NAME`) — propagating config into the OTel SDK, which reads the var by convention. The value originates from `appConfig`.

## Notes / follow-ups

- `WIKI_TRUST_PROXY=1` must be set in deployments behind a reverse proxy, otherwise `X-Forwarded-Proto`/`X-Forwarded-For` are ignored (safe default for direct exposure).
- M5 behavior change: space editors (and editor-initiated jobs) can no longer read secret values without an explicit per-secret grant.
- The 27 pre-existing test failures (document-edit Yjs suite, job-token validation suite, some CalDAV/permissions cases) pre-date this work and should be triaged separately.
