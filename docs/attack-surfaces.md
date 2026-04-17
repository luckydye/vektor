# Attack Surface Analysis — Vektor (Public Hosting)

## Critical

### 1. Job Sandbox Escape → Full Server Access

Worker thread fallback when `openshell` sandbox unavailable = **no isolation**. Jobs get full Node.js API: filesystem, `child_process`, network. Any user who can trigger a workflow/job could execute arbitrary code on the host.

**Location**: `app/src/jobs/scheduler.ts:101-131`

### 2. API Keys Leaked to Job Workers

`OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` passed directly in `workerData`. Malicious job code can exfiltrate these keys, exhaust quotas, or abuse them.

**Location**: `app/src/jobs/scheduler.ts:177-188`

### 3. Agent `curl` Bypasses SSRF Protection

Comment in code: *"bypassing just-bash's loopback/private IP block"*. Agents can reach internal services (metadata endpoints, databases, admin panels) via the custom curl command.

**Location**: `app/src/jobs/core.ts:1026-1080`

---

## High

### 4. No Rate Limiting on Auth

No rate limiting on:
- Login attempts (session auth)
- Access token validation
- Job token brute-force
- API endpoints generally

Enables credential stuffing, token brute-force, and API abuse.

### 5. `VEKTOR_NO_AUTH` Env Var

If accidentally set in production (`VEKTOR_NO_AUTH=1`), **all requests bypass authentication entirely**. Single env var misconfiguration = full compromise.

**Location**: `app/src/noAuth.ts`

### 6. Job Token 24-Hour Window

Job tokens valid for 24 hours. If leaked (logs, error messages, network sniff), attacker has a wide reuse window. Tokens are HMAC-signed with `AUTH_SECRET` — if that secret is weak, tokens are forgeable.

**Location**: `app/src/jobs/jobToken.ts:40-73`

---

## Medium

### 7. Extension Upload (ZIP Blob)

Extensions uploaded as ZIP blobs and stored in DB. If extension code is executed server-side without sandboxing, this is arbitrary code execution. Extension asset serving could expose unintended files.

**Endpoints**: `POST /api/v1/spaces/[spaceId]/extensions`, `GET .../extensions/[id]/assets/[...path]`

### 8. Document Import

`POST /api/v1/spaces/[spaceId]/import` — file parsing (HTML, Markdown, etc.) could trigger SSRF via embedded resources, XXE if XML-based formats are parsed, or stored XSS if HTML isn't sanitized.

### 9. Webhook Delivery (Outbound SSRF)

Webhooks POST to user-configured URLs. If no URL validation exists, attacker can:
- Probe internal services
- Hit cloud metadata endpoints
- Use the server as a proxy

### 10. CalDAV Over HTTP

Basic auth transmits credentials in base64 (reversible). Without TLS enforcement at the application level, credentials transit in cleartext.

### 11. `AUTH_SECRET` as Encryption Key Fallback

If `WIKI_SECRETS_ENCRYPTION_KEY` isn't set, falls back to SHA256 of `AUTH_SECRET`. Leaking one secret compromises both session signing and secret encryption.

**Location**: `app/src/db/secretsCrypto.ts:29-34`

### 12. SVG Upload Allowed

SVG files can contain JavaScript. If served with `Content-Type: image/svg+xml` and viewed in-browser, stored XSS is possible.

---

## Low (Well-Mitigated)

| Surface | Status |
|---------|--------|
| Path traversal (uploads) | Dual validation, secure |
| URL-metadata SSRF | CIDR blocking + DNS rebinding protection |
| WebSocket auth | Session + per-message role checks |
| OAuth CSRF | State param + PKCE + single-use + TTL |
| Secrets encryption | AES-256-GCM, proper IV/auth tag |
| File enumeration | 128-bit random filenames |

---

## Recommended Mitigations

| Priority | Action |
|----------|--------|
| **P0** | Enforce sandbox-only job execution; error if sandbox unavailable |
| **P0** | Proxy AI API calls through backend; never pass keys to workers |
| **P0** | Add SSRF protection to agent `curl` (match url-metadata CIDR checks) |
| **P1** | Rate limit auth endpoints (login, token validation) |
| **P1** | Add startup assertion that `VEKTOR_NO_AUTH` is not set in production |
| **P1** | Shorten job token TTL (15min instead of 24h) |
| **P2** | Validate webhook destination URLs against private IP ranges |
| **P2** | Serve SVGs with `Content-Disposition: attachment` or sanitize |
| **P2** | Enforce `WIKI_SECRETS_ENCRYPTION_KEY` is set separately from `AUTH_SECRET` |
