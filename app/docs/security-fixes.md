# Security Fixes — Task List

Tracking remediation of the API security audit. Status: ☐ todo · ◐ in progress · ☑ done

## Critical
- ☑ **C1** Access tokens bypass permission checks on write routes (`utils/auth.ts`) — now calls `verifyTokenPermission` (space- or resource-scoped) before granting `type:"job"`. Doc routes pass `{type:DOCUMENT,id}`.
- ☑ **C2** Job execution now fails closed — centralized `resolveJobSandbox()` (sandbox.ts) requires `WIKI_JOB_SANDBOX=openshell` or an explicit `WIKI_JOB_ALLOW_UNSANDBOXED=1` dev opt-in; `runJob` guards in-process execution too. All 3 call sites (run/workflow/cron) use it.

## High
- ☑ **H1** Webhook write routes used non-existent `"admin"` role → changed to `"owner"`; plus `meetsPermissionLevel` now fails closed on unknown required role (root-cause fix in `acl.ts`).
- ☑ **H2** Webhook SSRF — extracted shared `utils/ssrf.ts`; validate on create/update + re-validate at fire time in `db/webhooks.ts`.
- ☑ **H3** Access-token privilege escalation — added `verifyCanGrantTokenAccess` (rejects bogus perms/types, "can't grant more than you hold"); owner-gated token create/grant/revoke/delete.
- ☑ **H4** CalDAV PUT now requires `editor` via `requireCalDAVUserAndAccess({requiredRole})`; the space-level `index.ts` handler only serves read methods (REPORT/PROPFIND).
- ☑ **H5** Token search leak (`search/index.ts`) — now passes `token:<id>` / user id so `searchDocuments` ACL-filters; only userless job tokens get system view.
- ☑ **H6** Stored XSS — new `utils/servedFiles.ts`: uploads force `attachment` + sandbox CSP + nosniff for non-inline-safe types; extension assets get sandbox-opaque-origin CSP + nosniff.

## Medium
- ☑ **M1** Zip-slip in import (`import.ts`) — `extractZipFile` now resolves each entry under the root and rejects escapes; caps entry count (10k) and uncompressed size (500MB).
- ☑ **M2** User directory PII leak (`users/index.ts`) — bare listing removed; now `?id=` (minimal) / `?spaceId=` (members, no email) / `?spaceId=&scope=candidates` (owner-only, email). ApiClient + SpaceMembers/SpaceActivity updated.
- ☑ **M3** better-auth hardening (`auth.ts`) — rate limiting (strict on auth endpoints), `minPasswordLength: 12`, optional email verification, secure cookies on HTTPS, cookie prefix.
- ☑ **M4** Reviewed — NOT a vuln in the current access model. Both `listDocuments` and `listAllDocumentsByCategories` are space-scoped and gated on space-viewer; the doc ACL falls back to space permission, so every space viewer is entitled to all docs. Adding per-doc filtering here would be inconsistent. No change.
- ☑ **M5** OAuth group claims (`auth.ts`) — `sanitizeOAuthGroups` validates names against a charset, caps count, and intersects with optional `OAUTH_ALLOWED_GROUPS` allowlist.

## Low / Hardening
- ☑ **L1** Agent `curl` SSRF — now validates URL + every redirect hop via shared `utils/ssrf.ts` `safeFetch`.
- ☑ **L2** Job-token HMAC now fails closed if `AUTH_SECRET` is empty (`jobToken.ts`); secrets-key `AUTH_SECRET` fallback warns in production (`secretsCrypto.ts`).
- ☑ **L3** `VEKTOR_NO_AUTH=1` now throws at load time when `NODE_ENV=production` (`noAuth.ts`).
- ☑ **L4** url-metadata now requires an authenticated user (`url-metadata.ts`). DNS-rebind residual documented (redirect hops are re-validated; full IP-pinning deferred).

## Shared helpers introduced
- `src/utils/ssrf.ts` — `assertPublicUrl`/`isPublicUrl`/`isPrivateOrBlockedIp` + `SsrfError`; consumed by url-metadata, webhooks (create/update/fire), and the agent `curl` command.
- `src/utils/servedFiles.ts` — `contentDisposition`, `SERVED_FILE_CSP`, `EXTENSION_ASSET_CSP`, `servedFileSecurityHeaders` for serving user content safely.
- `src/db/api.ts` `verifyCanGrantTokenAccess` — central guard for token-grant authorization.
- `src/jobs/sandbox.ts` `resolveJobSandbox` / `SandboxRequiredError` / `isUnsandboxedExecutionAllowed` — single fail-closed sandbox policy.
- `src/db/acl.ts` `meetsPermissionLevel` — now fails closed on unknown roles.

## New / changed env vars
- `WIKI_JOB_ALLOW_UNSANDBOXED=1` — explicit opt-in to run jobs in-process (dev only).
- `OAUTH_ALLOWED_GROUPS` — optional comma-separated allowlist of IdP group claims.
- `VEKTOR_REQUIRE_EMAIL_VERIFICATION=1` — require verified email for password login.
