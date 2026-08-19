# Security testing & fuzzing playbook (for agents)

A practical guide for auditing Vektor for security and correctness bugs. Written from a
multi-round audit that filed ~50 issues. Read this **before** you start — the biggest time-saver
is the auth model in §2, and the biggest quality-saver is the verification discipline in §6.

The golden rule: **verify every finding empirically (a real repro) or with an exact vulnerable
code path before filing. Never file a bug you have not reproduced or traced to specific lines.**

---

## 1. What Vektor is (threat model in one screen)

Self-hosted, multi-tenant collaborative docs platform.

- **Runtime/stack:** Bun; Hono API under `app/src/api/routes/`; better-auth; Drizzle ORM over
  **per-space SQLite files** (`data/spaces/space_*.db`); Yjs realtime (`app/src/realtime/`);
  Tiptap/ProseMirror + CodeMirror editor (client); Astro + Vue + Solid; Rust native modules
  (`app/native/` — image, exec, embedding); jobs/workflow runtime (`app/src/jobs/`).
- **Tenancy:** each space has its own SQLite DB. Cross-space isolation is largely structural
  (a doc id from space B does not resolve in space A's DB). ACL is per-space.
- **Run modes:** `vektor serve --no-auth` (everyone is one LOCAL super-user) and
  `vektor serve --email-auth` (real multi-user with better-auth).
- **Who the attackers are:** an anonymous internet user; a self-registered account with no spaces;
  a space **viewer**; a space **editor**; a **document-level grantee** with no space role; and
  (for lower-severity/insider bugs) an owner. Most interesting bugs are "a lower role does
  something only a higher role should."

Primary assets to protect: document content/titles/properties, file attachments, revision history,
secrets/API keys, workflow run inputs/outputs, user identity/PII, and the server process itself
(availability).

---

## 2. The ACL / auth ground-truth model — READ THIS FIRST

Most "leak" false positives come from not knowing this. Establish it empirically once, then apply
it everywhere.

- **Roles:** `viewer < editor < owner` at space scope.
- **Grants only ADD.** `getDocumentPermission` (`app/src/acl/store.ts`) returns the **strongest**
  of a document's direct / document_tree / category / **space** grants. Consequences:
  - A space member with role R holds **≥ R on every non-archived document**. So "endpoint X shows
    a space member data about other documents in the same space" is **NOT** a leak — they can read
    those docs anyway. Do not file it.
  - There is **no per-document "deny"** (`action` is only `grant`/`revoke`). You cannot restrict a
    document *below* a member's space role.
- **THE key divergence — archived documents.** `requiredRoleForDocument` (`app/src/acl/guards.ts`)
  raises the required role to **EDITOR** for archived docs. So a plain **viewer is denied archived
  documents**. Any endpoint that exposes archived-doc data (content, title, attachments, run
  artifacts, breadcrumb ancestor titles) to a viewer **is a real bug** — this is the single most
  productive confidentiality vein. (Found: #121 archived attachments, #138 run artifacts,
  #140 reparent-under-archived leaks title.)
- **Feature gates are never implied by role.** `VIEW_HISTORY`, `VIEW_AUDIT`, `COMMENT` must be
  granted explicitly. `verifyFeatureAccess(spaceId, Feature.X, userId, documentId?)` — **if the
  `documentId` argument is omitted on a document-scoped endpoint, it falls back to the space role**,
  which is a bug (a document-scoped editor is wrongly refused, or history/audit data leaks without
  the feature). Grep all `verifyFeatureAccess` calls and check the `documentId` arg.
  (Found: #151 comments, #152 audit.)
- **Public access.** `authenticateSpaceAccess(...).isPublic` is true **only** when the *space* has
  a `public`-group grant. A doc-level public grant does **not** confer space-wide access — an
  anonymous caller then gets `401` on space endpoints and `0` results from search. So "public
  document in a private space leaks siblings" is a **false positive** — verify before believing it.
- **Document-level grantee (no space role):** can reach only granted resources via resource grants.
  Endpoints that require a *space* role wrongly deny them (availability bug, lower severity but
  real — e.g. attachments/comments/audit for a `document_tree` editor: #150/#151/#152).

**Verify the model yourself** on `:4321`: create Alice(owner), Bob(space-viewer), Carol(doc-grantee,
no space role); confirm Bob reads every non-archived doc (200) but archived docs are 403; confirm a
doc-level public grant does NOT let anon hit `/properties` or search. Takes 5 minutes and prevents
hours of false positives.

---

## 3. Environment setup

The binary is `app/vektor` (build with `mise exec -- task compile` from repo root; run `bun i` at
root and in `app/` first if Astro/tsconfig errors). Copy it into isolated run dirs so each server
has its own data.

### Two servers, two purposes

```bash
SP=<scratch>            # a writable scratch dir
mkdir -p $SP/noauth_run $SP/auth_run
cp app/vektor $SP/noauth_run/vektor
cp app/vektor $SP/auth_run/vektor

# no-auth: everyone is a super-user. Use for VALIDATION / 500s / injection / DoS / native / SSRF.
# (Authorization bugs are INVISIBLE here — everyone is owner.)
cd $SP/noauth_run && env -i PATH=/usr/bin:/bin HOME=$HOME VEKTOR_DATA_DIR=$SP/noauth_run/data \
  ./vektor serve --no-auth --port 8080

# email-auth: real multi-user. Use for ALL AUTHORIZATION / ACL / privilege bugs.
cd $SP/auth_run && env -i PATH=/usr/bin:/bin HOME=$HOME VEKTOR_DATA_DIR=$SP/auth_run/data \
  ./vektor serve --email-auth --port 4321
```

**Always start servers with the harness's background-run mechanism, not a shell `&`** — a `&`
job dies when the shell command returns. **Use `env -i`** so a stray `VEKTOR_NO_AUTH=1` in the
environment can't silently downgrade the email-auth server to no-auth (a real trap — it makes every
user look like "local" super-user and every ACL test pass).

### Multi-user fixtures (:4321)

```bash
A=http://localhost:4321
sign_up() { curl -s -c $SP/$1.jar -X POST $A/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$1@t.co\",\"password\":\"Password123!\",\"name\":\"$1\"}"; }
sign_up alice; sign_up bob; sign_up carol
# ids: curl -s -b $SP/alice.jar $A/api/v1/users/me
# grant roles: POST /api/v1/spaces/:id/permissions
#   {"type":"role","roleOrFeature":"viewer|editor|owner","userId":"..","action":"grant|revoke"}
#   resource grants add: "resourceType":"document|document_tree|category|space","resourceId":".."
#   public: "groupId":"public" (no userId)
```

Build the canonical scenario once and reuse it: **Alice owns a private space; Bob is a space
viewer; Carol has a `document_tree`/document grant but no space role; a hierarchy of
private-parent + shared-child; and at least one archived document.** This exercises every ACL edge.

### Shell tips (this environment)

- Use `bun` for JSON in shell: `curl ... | mise exec -- bun -e 'const d=await Bun.stdin.json(); ...'`.
- `fflate` (for building test zips) only resolves when run from `app/` (`cd app && bun -e ...`).
- To kill a server: it appears in `pgrep -af` as `./vektor serve --no-auth --port 8080`
  (match on `serve --no-auth` or `serve --port 8080`, or kill by PID). `pkill -f` on the run-dir
  path often misses it.
- After **every rebuild, re-copy the binary** into the run dirs — a stale binary silently makes you
  test old behavior (a repeated, costly trap).

---

## 4. Methodology that works

1. **Learn the model (§2) first.** Everything downstream depends on it.
2. **Fan out by domain, not by file.** Independent auditors per surface find more than one serial
   pass. Domains that paid off: (a) authorization/ACL per-resource; (b) input-validation/500s/
   injection; (c) SSRF/file-handling/path; (d) data-integrity/DoS; (e) auth/session/OAuth/CLI;
   (f) realtime/Yjs + extensions; (g) jobs/workflow runtime; (h) CalDAV + output-encoding;
   (i) content-sanitization/XSS; (j) search/query; (k) native modules; (l) notifications/tokens;
   (m) SSR/publishing/provisioning; (n) concurrency/TOCTOU; (o) quotas/resource-abuse.
3. **Give every auditor the exclusion list** (already-filed issues + already-confirmed-robust
   areas). Re-reporting known bugs is the main source of noise across rounds.
4. **Verify, then file — immediately, one at a time.** Do not batch to the end. Each confirmed,
   non-duplicate finding → a GitHub issue right away (§7).
5. **Dedupe hard.** Multiple auditors will independently find the same DoS/leak. File the distinct
   root cause once; fold near-duplicates or reference the related issue.
6. **Be honest about yield.** After a surface is well-audited, agents increasingly return
   "confirmed robust, 1 finding." Report the real count; never pad with ambiguous/duplicate issues.

---

## 5. Bug taxonomy — where the bugs actually were

Ordered roughly by yield. For each: the pattern, where to look, and how to trigger it.

### 5.1 Missing per-resource / feature authorization (highest yield)
The maintainer's own recurring bug. An endpoint returns per-document or feature-gated data but
checks only a **space role** (`verifySpaceRole`/`authenticateSpaceAccess`) or omits the
`documentId`/feature.
- **Look:** every handler in `app/src/api/routes/spaces/`. Grep each for its guard. Flag any that
  return document-specific or history/audit data behind only a space-role or a
  `verifyFeatureAccess(...)` **without** `documentId`.
- **Trigger:** the archived-doc case (viewer denied the doc directly but the endpoint serves its
  data), and the document-grantee case (Carol reaches/ is denied a specific doc).
- **Found:** breadcrumbs, contributors, `/properties`, uploads list/serve, audit-logs, comments,
  workflow run artifacts.

### 5.2 Archived-document leaks
Archived = editor-only. Any path that surfaces an archived doc's content/title/attachments/artifacts
to a viewer is a leak.
- **Look:** endpoints that don't apply `nonArchivedDocumentCondition` or `requiredRoleForDocument`;
  file-serving keyed on space role; breadcrumb/tree walks that include archived ancestors; reparent
  that puts a live child under an archived parent.

### 5.3 DoS / unbounded work on the event loop (high yield, high impact)
Bun is single-threaded; any unbounded synchronous per-item work blocks or OOM-crashes the whole
multi-tenant process.
- **Look:** `SELECT ... content ... FROM document` with **no LIMIT** then JS ranking (search); a
  synchronous diff/`prettyPrintHtml` over full revisions (revision-diff); `unzipSync` with no
  output cap (zip-bomb, re-run per request); embedding every stale doc synchronously on the request
  path through a global mutex; **no request-body/content-size limit anywhere**; **no per-user quota
  on space/resource creation** (each space = a new SQLite file + a cached FD).
- **Trigger:** create a few large docs and search; two large revisions and diff; a compressed zip
  of zeros; loop `POST /spaces`. **⚠ These can crash the shared server** — see §8; isolate them.
- **Found:** #144, #146, #153, #154, #156, #167, #129.

### 5.4 Input validation → 500 (should be 400)
- **Look:** `parseJsonBody` returns `null` for a `null` body → destructuring throws (systemic across
  write endpoints); array/object where a string is expected reaching a Drizzle bind; a parsed
  manifest/JSON whose *shape* isn't validated before property access.
- **Trigger:** `-d 'null'`, `{"categoryIds":[{"a":1},123]}`, malformed-shape manifest zip,
  unvalidated `date`-typed property → later `new Date(x).toISOString()` throws (also breaks CalDAV).
- **Found:** #124, #125, #145, #170.

### 5.5 XSS / markup injection sinks that bypass the sanitizer
The core sanitizer (`app/src/utils/html.ts` `sanitizeDocumentHtml`/`sanitizeSvgMarkup`/
`sanitizeVektorDocumentPreviewHtml`) is **robust** — don't re-fuzz it. Bugs are in sinks that
**don't route through it**, or attributes it keeps unvalidated (`data-*`, SVG paint attrs).
- **Look:** grep the client for `innerHTML`, `v-html`, `dangerouslySetInnerHTML`,
  `insertAdjacentHTML`, `shadow.innerHTML`, `window.open`. For each, trace whether the value is
  user content and whether it's sanitized. The sanitizer keeps custom elements (`<a-shortcut>`) and
  every `data-*` attribute; a node view that re-parses a `data-*` value via `innerHTML` is
  injectable. Markdown renderers that override the *link* renderer but not the *image* renderer
  allow `![](url)` beacons.
- **Found:** #161 (canvas workflow `output.html` raw into shadow DOM — the sanitized twin is
  `WorkflowView.tsx`), #162 (comment/AI markdown image), #163 (target=_blank no rel), #164
  (svg paint `url()`), #171 (`<a-shortcut data-shortcut>` innerHTML), #172 (mention `data-href`).

### 5.6 SSRF / outbound-fetch
- **Look:** grep `fetch(`; classify each reachable one as `safeFetch` (pins the validated IP) vs
  bare `fetch` (re-resolves DNS → rebinding TOCTOU). `assertPublicUrl`-then-bare-`fetch` is a
  rebinding hole. Also path-confinement: a URL builder that validates the absolute branch but not
  the relative branch (`..` climbs out; the final check is origin-only).
- **Found:** #123 (url-metadata rebinding), #169 (GitLab `/api/v4` bypass). Already-fixed:
  proxy-media redirect, integration-proxy protocol-relative, job-fetch, AI baseUrl.

### 5.7 Token / privilege lifecycle
- **Look:** `validateAccessToken` re-checks creator membership but not the creator's *current
  role* → a token survives its issuer's **demotion**. Role change doesn't revoke issued tokens.
  `deleteAccessToken` may not remove the token's ACL grants (orphan `token:` grantees).
- **Trigger (multi-user):** promote Bob→owner, Bob mints an owner token, demote Bob→viewer; Bob's
  session 403s but the token still writes.
- **Found:** #158, #159.

### 5.8 Data-integrity / logic
- **Look:** non-atomic `max(rev)+1` with an `await` gap → duplicate revision numbers under
  concurrency; `publishedRev` can point at an open suggestion; comment DELETE authorized against a
  caller-supplied `documentId` not the comment's own; content-addressed upload dedup reassigns
  another doc's attachment; category delete leaves dangling slug refs; readonly lock not enforced on
  PATCH properties/parentId/publishedRev.
- **Found:** #165, #149, #139, #168, #173.

### 5.9 Info disclosure / enumeration
- **Look:** endpoints that return distinct errors for "not found" vs "denied" (existence oracle);
  SSR page routes returning 404 vs 302/403; a user lookup that resolves any id→name without a
  shared-space check.
- **Found:** #142 (url-metadata), #166 (SSR space), #141 (user id).

### 5.10 Sandbox / capability / confused-deputy (jobs & extensions)
- **Look:** the `exec` capability allowlists the binary but passes guest **args** unconfined
  (absolute-path file read/write); workflow-run **resume** inherits another user's unredacted
  inputs with no ownership check; a schedule runs as its `createdBy` but any editor can PATCH it;
  extension package decompression is uncapped; extension update preserves `source`/`sourcePublisher`
  (provenance spoof).
- **Found:** #143, #137, #122, #129, #130.

### 5.11 Concurrency / TOCTOU
- **Look:** check-then-act outside a transaction with a wide `await` window. Fire N parallel
  requests and check the invariant. **Note:** paths wrapped in `s.tx(...)` (reparent-cycle,
  last-owner-removal) are serialized by libsql and did **not** reproduce; the vulnerable one had a
  long `await compressHtml` between read and insert. Slug uniqueness is latent (non-atomic) but the
  window was too narrow to demonstrate.

---

## 6. Verification discipline (this is what makes findings real)

- **Reproduce or trace.** Either a real HTTP repro with observed status/output, or exact
  `file:line` showing the vulnerable path. Multi-user privilege deltas can't be shown on `--no-auth`
  (everyone's a super-user) — use `:4321` or argue from code.
- **Actively try to falsify.** Two agent-reported "leaks" were **false positives** killed by a
  5-minute empirical check: a doc-level public grant does NOT confer space-wide access, and no
  per-doc deny exists, so "public/space-viewer sees restricted docs" is impossible. If a finding
  depends on an ACL capability, confirm that capability exists.
- **Re-verify with the right endpoint/field.** Several first attempts failed because of the wrong
  route (revision *restore* vs *save*), the wrong response field (`token.id` vs `token`), or the
  draft-content field vs the sanitized revision. A "does not reproduce" often means "wrong probe" —
  re-check before discarding.
- **Watch the server binary.** If behavior looks unfixed after a pull, confirm the running server is
  the freshly-built binary (§3), not a stale copy.
- **Distinguish "no longer 500" from "fixed."** A 400 is fixed; a silent 200 that stores garbage may
  not be. Check the actual post-condition.

---

## 7. Filing (GitHub issues)

Use `gh` (the repo's convention). One issue per distinct root cause, most-severe first.

- **Labels:** `bug`, plus `security` for genuinely security-relevant findings (omit `security` for
  pure robustness/correctness like a 500 or a search-relevance bug), plus one severity label:
  `severity:critical|high|medium|medium-high|low-medium|low`.
- **Body template:** Summary → Root cause (`file:line`) → Repro (observed status/output, or exact
  code path) → Impact → Fix → Severity. Reference related filed issues (`#NNN`) when a finding is a
  sibling/distinct-instance so the maintainer can dedupe.

```bash
gh issue create --title "<concise, specific>" --body-file <path> --label "bug,security,severity:high"
```

Note: creating issues is an outward-facing action and may require explicit user approval — confirm
before mass-filing.

---

## 8. Operational gotchas (learned the hard way)

- **Backgrounded `&` servers die** when the Bash tool call returns. Use the harness's
  background-run; verify health (`curl :8080/api/v1/spaces`) before driving it.
- **DoS repros crash the shared server.** Large-doc search and revision-diff can OOM the process
  (connection-refused afterward). Run destructive repros last, in an isolated space, and expect to
  restart. If you crash it, restart it (or tell the coordinator) — don't leave it down for other
  agents.
- **Stale binary** after a rebuild → you're testing old code. Re-copy every time; check timestamps.
- **`env -i`** for the auth server or a leaked `VEKTOR_NO_AUTH` makes every ACL test spuriously pass.
- **Per-space DB isolation is real** — a doc id from space B returns 404 in space A; cross-space
  parenting/reparent is rejected. Don't chase cross-space reads; they're structurally blocked.
- **Concurrent agents hammering one server** cause transient timeouts that look like hangs/crashes;
  re-check health before concluding the server is dead.

---

## 9. Known-robust areas (don't re-walk without a new angle)

Confirmed solid across rounds — only revisit with a concrete new vector:
core HTML sanitizer; SQL/FTS injection (search is **in-memory**, not FTS5; filters guarded by
`Object.hasOwn`; cursors bounded); OAuth connect/callback (state+PKCE, per-space-DB binding);
CLI-token flow; session/cookie/CSRF (Origin check on unsafe methods); IdP group sync
(`input:false` + `sanitizeOAuthGroups`); mass-assignment (`createdBy`/`id`/`archived`/`publishedRev`
ignored on create); members/users endpoints don't leak email; access-token **resource** scoping;
better-auth rate-limits on sign-in/up/forget; native image transform (bounded `Limits`), embedding,
and exec marshal (bounds-safe) — no memory-safety/panic path found; Yjs/binary frame decode (caught
in try/catch); revision brotli (off-thread, guarded on read); email header/HTML injection (escaped);
HTTP method-override / path-normalization / trailing-slash bypasses; viewer role authorization on
writes/deletes; transaction-wrapped concurrency paths (reparent-cycle, last-owner).

---

## 10. Quick-start checklist for a new agent

1. Read §2 (auth model). Stand up both servers (§3). Build the Alice/Bob/Carol + archived-doc
   scenario and confirm the model holds.
2. Pick an un-audited domain (§4). Pull the current open-issue list as your exclusion set.
3. Hunt the §5 patterns for that domain. For each candidate: reproduce it (or trace exact lines),
   then actively try to falsify it (§6).
4. File each confirmed, non-duplicate finding immediately (§7).
5. When the domain reads as "robust, occasional finding," say so and stop — don't pad.
