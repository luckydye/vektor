# Vektor API design review

A review of the Vektor HTTP API (`/api/v1`) and the published client (`@vektorapp/api`)
against Sean Goedecke, *[Everything I know about good API design][post]* (24 Aug 2025).

The post's sections are used as the review's headings, in the post's order. Each section
states the principle, then what Vektor does about it. Nothing here is a style preference
that the post does not argue for.

[post]: https://www.seangoedecke.com/good-api-design/

**Scope reviewed:** `app/src/api/` (router, helpers, all `routes/spaces/*` handlers),
`app/docs/api.md`, and `api/src/index.ts` (the published read-only client). CalDAV,
better-auth, and the ACP/completions proxies were read but are largely out of scope —
they implement other people's protocols, where the post's advice does not apply.

**Verdict.** The read path is in good shape and gets several of the post's harder points
right without being told: cursor pagination, expensive fields off by default, long-lived
API keys, and Markdown docs. The write path and the operational envelope are where the
gaps are, and they cluster into three real problems: **no rate limiting at all**, **no
idempotency on creates**, and **a stated policy of breaking compatibility on an API that
already has a published client on npm**. Below those, a layer of inconsistency that costs
consumers exactly the attention the post says they should not have to spend.

---

## 1. Designing APIs is a balance between familiarity and flexibility

> "Good APIs are boring. An API that's interesting is a bad API." Any time a consumer
> spends thinking about the API instead of their goal is time wasted.

Mostly good. `GET /spaces/:id/documents`, `POST /spaces/:id/documents`,
`GET/PUT/PATCH/DELETE /spaces/:id/documents/:documentId` is exactly the boring shape a
consumer can guess. Slug-or-id resolution on the same path
(`app/src/api/routes/spaces/document.ts:280-287`) is a genuine kindness — it removes a
lookup round-trip and a whole class of "which identifier do I have?" confusion.

**Finding 1.1 — `GET /documents/:documentId` is the most interesting endpoint in the API.**
One URL has five modes and three response body types:

| Request | Response |
|---|---|
| (default) | `200 { document, space }` |
| `?draft=true` | `200 { document, space }`, editor-gated |
| `?live=true` | `200 { document, space }`, editor-gated, content from the Yjs room |
| `?rev=N` | `200 { revision }` — different top-level key, no `space` |
| `Accept: text/markdown` | `200` with a `text/markdown` body, not JSON at all |

A consumer cannot type this endpoint once. The published client already pays for it: it
has two methods (`getDocument`, `getRevision`) pointing at the same URL with different
return types (`api/src/index.ts:290-311`). `?rev=N` is a different resource — revisions
have their own collection at `/documents/:documentId/revisions` — and belongs at
`/documents/:documentId/revisions/:rev`, where `getRevision` would be an ordinary GET.

**Finding 1.2 — `PUT /documents/:documentId` carries two unrelated operations.**
`{ restore: true }` returns `{ success: true }`; a content update returns
`{ document }` (`document.ts:495-499` vs `:564`). `?publish=true` changes what the write
means again. Restore is a state transition on an archived document, not a content write —
`POST /documents/:documentId/restore` says so, and leaves PUT with one response type.

**Finding 1.3 — `PATCH` accepts exactly one field per request.**
`document.ts:110-114` rejects a body with more than one of `properties`, `parentId`,
`publishedRev`, `readonly`. Renaming a document and reparenting it is two requests that
cannot be made atomic by the consumer. This is the opposite of boring — every other PATCH
in the world merges the fields present. The strict *unknown*-field rejection above it
(`:99-109`) is good and should stay; the one-field rule should go.

**Finding 1.4 — `?grouped=true` changes the response type.**
`GET /documents?categorySlugs=a,b` returns `{ documents, total, limit }`; adding
`&grouped=true` returns `{ documentsByCategory, categorySlugs }`
(`documents.ts:131-153`). The client models this as two methods with unrelated return
types (`listDocuments` vs `listDocumentsByCategories`), and `listDocuments`' declared
`Page<Document>` is not what the server sends for either the `categorySlugs` or the
`parentId` path. A query parameter that changes the response *shape* is the thing a
consumer cannot guess.

---

## 2. WE DO NOT BREAK USERSPACE

> Additive changes are fine; removing fields, changing their types, or restructuring them
> breaks every consumer. Maintainers have "something like a sacred duty" here.

**Finding 2.1 — the repo's stated policy directly contradicts this, and there is now a
published consumer.** `AGENTS.md` says:

> "Do not worry about backwards compatibility, unless requested otherwise."

That is a reasonable rule for a single-binary app's internal code. It is not a reasonable
rule for `/api/v1`, because `@vektorapp/api@0.4.1` is a separate published package whose
whole job is to consume it from someone else's website, and `.well-known/vektor` actively
advertises `apiVersion: "v1"` and a stable `documentEndpoint` template to third parties
(`app/src/api/routes/well-known/vektor.ts:17-23`). The `v1` in the path and the
`.well-known` advertisement are a compatibility promise; `AGENTS.md` disclaims it. One of
the two has to change.

The cheapest fix is to scope the disclaimer rather than weaken it — the API surface splits
cleanly in two, and the post's own "Internal APIs" section says the halves deserve
different rules:

- **Public/contract surface** — everything the client calls plus `.well-known/vektor`:
  `GET /spaces`, `/spaces/:id/documents`, `/spaces/:id/documents/:documentId`,
  `/spaces/:id/categories`, `/spaces/:id/search`. Additive changes only.
- **Internal surface** — everything the Vektor UI calls and nothing else: workflows,
  extensions, secrets, integrations, ai-chat, jobs, audit-logs, permissions. Break freely;
  the UI ships with the binary.

Write that split into `AGENTS.md` and `app/docs/api.md`. It costs one paragraph and it is
the difference between "we do not break userspace" and "we have no idea who we are
breaking."

**Finding 2.2 — no field is documented as stable, so all of them are.**
`app/docs/api.md` describes responses but never says which fields are contract. Consumers
will depend on whatever they can see, including `mentionCount`, `hasHiddenCategories`, and
`headerImageAspectRatio`. If some of those are UI-only, say so in the docs.

---

## 3. Changing APIs without breaking userspace (versioning)

> Versioning means serving old and new simultaneously. Use it as a last resort — it is
> "a necessary evil" and "a nightmare for maintainers."

Vektor has the URL-prefix form (`/api/v1`) already, which is the version of this the post
recommends as easiest, and it has never needed a v2. Nothing to fix; the advice is to keep
it that way by making changes additive (§2) rather than by getting good at versioning.

One note: the router has no mechanism to serve two versions concurrently — `apiRoutes`
maps one pattern to one module (`app/src/api/routes.ts:73-79`). That is the right call
today. It does mean a v2 is a genuinely expensive event, which is another argument for
holding the line additively.

---

## 4 & 5. The product, and how product design leaks into the API

> "Technical constraints that can be cleverly hidden in the UI are laid bare in the API,
> forcing API consumers to understand far more of the system design than they should
> reasonably have to."

This is the post's sharpest point and the one with the most to say about Vektor, because
Vektor's core technical constraint — CRDT-backed collaborative editing with a revision
chain — is visible in the API surface in a way it is not in the UI.

**Finding 4.1 — the consumer must understand the revision model to read a document.**
A `Document` carries `currentRev` and `publishedRev`; reading it means knowing that the
default serves the published revision, `?draft=true` serves the working copy and needs
editor, and `?live=true` serves the Yjs room and also needs editor. A consumer who just
wants "the page my readers see" has to learn three storage tiers to be confident they got
it. The default is the right one, so this is mostly a documentation problem — but
`app/docs/api.md` documents the parameters without ever saying plainly *"omit all of them;
you will get the published content."*

**Finding 4.2 — the 401/403/404 conflation forces consumers to guess.**
The clearest evidence that this leaks is in the client, which had to write a heuristic
(`api/src/index.ts:243-252`):

> "Vektor answers 401 both for a document that is not public and for a rejected token, so
> that status only counts as absence when no token was configured — a bad token must stay
> loud instead of emptying the whole site."

That comment is a bug report about the API. A consumer should not have to reason about
whether their credentials were configured in order to tell "this page does not exist" from
"your token is wrong" — getting it backwards silently blanks a production website. Fix it
at the source: **401 only for a credential that failed to authenticate; 404 for a resource
the caller may not see; 403 only when the caller is known and genuinely lacks the role.**
Then `isNotVisible` collapses to `status === 404` and the heuristic disappears.

**Finding 4.3 — reserved path segments shadow real documents.**
`/documents/archived` is a literal route and the matcher scores literals above params
(`app/src/api/server/matcher.ts:14-16`, `sortRoutes`). Because `/documents/:documentId`
also resolves *slugs*, a document whose slug is `archived` is unreachable — the request
silently returns the archived-documents listing instead. The same hazard applies to any
future static child of `/documents`. Either document `archived` as a reserved slug and
reject it at creation, or move the listing to `/documents?archived=true` and remove the
collision class entirely.

---

## 6. Authentication

> "You should let people use your APIs with a long-lived API key… Every integration with
> your API begins life as a simple script." Many consumers are not professional engineers.

**Good, and this is done right.** `Authorization: Bearer at_<token>` long-lived access
tokens are a first-class auth mode alongside session cookies, scoped per resource through
the ACL (`app/docs/api.md:15-24`), and the published client accepts one as a single
constructor option. A curl one-liner works. This is exactly what the post asks for and it
needs no change.

Two smaller notes:

- The CSRF guard correctly lets `Origin`-less requests through, so curl and token clients
  are not caught by it (`app/src/api/server/router.ts:29-49`). The reasoning is written
  down in the comment. Good.
- `GET /spaces/:spaceId/secrets/:name` returns the plaintext secret value
  (`routes/spaces/secret.ts:49`). That is defensible for a self-hosted space-owner API,
  but it means an access token with the right grant is a secret-exfiltration key. Worth an
  explicit line in the docs so operators scope tokens deliberately. (Security, not API
  design — flagged in passing, not a finding against the post.)

---

## 7. Idempotency and retries

> Requests that take action should support an idempotency key so retries after a 500 or a
> timeout do not duplicate. Not needed for reads; DELETE-by-id is self-idempotent.
> Idempotency should be optional.

**Finding 7.1 — no idempotency mechanism exists anywhere in the API.** A repo-wide grep
for `Idempotency` finds one unrelated comment. Concretely:

- `POST /spaces/:spaceId/documents` — a timeout on a large document, retried, creates a
  second document. Slug uniqueness does not save you: `createDocument` resolves collisions
  by suffixing, so the retry succeeds and yields a duplicate.
- `POST /spaces/:spaceId/comments`, `POST /spaces/:spaceId/categories`,
  `POST /spaces/:spaceId/access-tokens` — same shape. A duplicated access token is the
  worst of the three.
- `POST /spaces/:spaceId/workflows/runs` returns `202 { runId }`
  (`routes/spaces/workflow-runs.ts:194`) — a retried workflow run executes the workflow
  twice, with whatever side effects that workflow has.

The post's minimum viable version is cheap and fits Vektor: accept an optional
`Idempotency-Key` header on POST, store `(spaceId, key) → response` in the space's SQLite
store with a few hours' TTL, and replay the stored response on a repeat. Optional, so
non-engineer consumers are unaffected. Start with `POST /documents` and
`POST /workflows/runs`.

**Already correct:** `DELETE /documents/:documentId` is keyed by id, so retries are
naturally safe — the post explicitly exempts this case. `PUT` is content-replacing and
converges. Reads need nothing.

---

## 8. Safety and rate limiting

> "Any operation you expose via an API can be called at the speed of code." Put a rate
> limit on your API with tighter limits for expensive operations, reserve a killswitch,
> and return `X-Limit-Remaining` and `Retry-After`.

**Finding 8.1 — this is the largest gap. There is no rate limiting on `/api/v1` at all.**
The only rate limit in the codebase is better-auth's internal one on `/api/auth/*`
(`routes/auth/all.ts:6`). No handler returns 429, nothing emits `Retry-After` or
`X-Limit-Remaining`, and there is no killswitch to shed load from one caller.

The post's own list of incident causes maps onto specific Vektor endpoints:

| Post's failure mode | Vektor endpoint | Cost per call |
|---|---|---|
| "Polling a big `/index` endpoint with no delay" | `GET /documents?limit=500` | 500-row ACL-filtered scan |
| "APIs that do a lot of work in a single request" | `POST /search/rebuild` | rebuilds every embedding in the space |
| — | `POST /chat/completions`, `POST /chat/acp` | proxied LLM inference, billed to the operator |
| — | `GET /url-metadata` | outbound fetch per call (SSRF-guarded, not rate-limited) |
| — | `GET /proxy-media` | outbound fetch + transcode |
| — | `POST /jobs/run`, `POST /workflows/runs` | arbitrary user-defined execution |
| — | `GET /uploads/*path` with transforms | image decode/resize per request |

`POST /search/rebuild` and `POST /chat/completions` are the two that most deserve a
tighter bucket than everything else — one is O(space) work behind a single call, the other
spends the operator's money.

The counterargument is that Vektor is self-hosted, so the operator and the caller are
often the same person. That holds for a single-user instance and stops holding the moment
a space is shared, made public, or handed an access token — and the post's whole point is
that you cannot anticipate what people build on top of an endpoint. A default limit with a
generous ceiling, tighter buckets for the table above, and the two response headers would
close this. Since `isTrustProxyEnabled`/`clientIp` (`router.ts:52-58`) already resolves a
caller IP, and tokens carry a `tokenId`, the keying material is in hand.

**Finding 8.2 — `?permanent=true` is a hard delete behind a query parameter.**
`DELETE /documents/:documentId?permanent=true` (`document.ts:685,701`) is irreversible, and a
typo'd truthy value is the difference between archive and destroy. Not something the post
covers directly, but it is the same "called at the speed of code" hazard: consider
requiring a confirmation body or a separate route for the destructive form.

---

## 9. Pagination

> Use cursor-based pagination for datasets that might get large. Include a `next_page`
> field so consumers do not compute the cursor themselves.

**Good foundation.** Vektor is cursor-based (not offset-based) on every paginated list and
returns `nextCursor` in the body, which is exactly the recommendation. Limits are capped
(500 for documents, 100 for search), so no caller can ask for the whole table.

The problem is that the same concept is spelled four ways, which is a §1 familiarity cost
paid on every list endpoint:

**Finding 9.1 — list response shapes are inconsistent.**

| Endpoint | Body |
|---|---|
| `GET /documents` | `{ documents, total, limit, nextCursor }` |
| `GET /documents?parentId=` | `{ documents, total, limit, nextCursor: null }` — unpaginated |
| `GET /documents?categorySlugs=` | `{ documents, total, limit }` — **no `nextCursor` key at all** |
| `GET /documents/archived` | `{ documents, limit, nextCursor }` — no `total` |
| `GET /search` | `{ results, nextCursor, query, limit, filters }` |
| `GET /search` (empty query) | `{ results, nextCursor, query, filters }` — **`limit` dropped** |
| `GET /audit-logs` | `{ auditLogs, limit, nextCursor }` |
| `GET /jobs/runs` | `{ runs, limit, nextCursor }` |
| `GET /categories`, `/comments`, `/members`, … | bare arrays, no pagination |

The empty-search case is already leaking into the client, which types `limit` as optional
purely to model it (`api/src/index.ts:159-161`). Settle on one envelope — items under a
per-resource key, always `nextCursor` (`null` on the last page, never absent), `limit`
always present — and use it everywhere.

**Finding 9.2 — `total` means two different things on one endpoint.**
On the default path it is the full collection count; on the `categorySlugs` and `parentId`
paths it is `documents.length` (`documents.ts:151,160`). A field whose meaning changes with
the query is worse than an absent field, because a consumer building a pager on `total`
gets a plausible wrong answer instead of an error. Same for `limit`, which is reported as
`documents.length` on those paths — a caller who sent `limit=50` is told their limit was 7.

**Finding 9.3 — `limit` validation contradicts itself across endpoints.**
`GET /documents` hand-parses `limit` and silently coerces (`documents.ts:81-84`):
`limit=abc` → 50, `limit=-5` → 50, `limit=99999` → 500. Every other paginated endpoint
uses `parsePaginationParams`/`parseQueryInt`, which returns **400** for all three
(`app/src/api/http.ts:104-129`). Same parameter name, same API, opposite contracts. Route
`GET /documents` through `parsePaginationParams` — it is a two-line change and the helper
already exists.

**Finding 9.4 — `PaginatedResult<T>` in `http.ts:132-136` is unused.** It declares a
`{ data, limit, nextCursor }` envelope that no route emits. Either adopt it as the shape
from 9.1 or delete it, so it stops advertising a convention that does not exist.

**Finding 9.5 — some unpaginated lists can grow without bound.**
`GET /categories`, `/comments?documentId=`, `/documents/:id/children`,
`/documents/:id/revisions`, and `/uploads` all return complete arrays. Categories and
children are naturally small. Comments and revisions on an old, busy document are not, and
revisions grow monotonically forever. The post's advice is to adopt cursors *before* the
scaling problem, "because the cost of making that change is often very high" — and here it
is higher than usual, since adding pagination to a list endpoint is precisely the breaking
change §2 forbids. Paginate `/revisions` and `/comments` now, while the client that
consumes them is still yours.

---

## 10. Optional fields

> "If parts of your API response are expensive to serve, make them optional." An
> `include`-style parameter is the general form. GraphQL is overkill.

**This is Vektor's strongest area, and it was clearly done deliberately.** Four separate
places get it right, each with the reasoning in a comment:

- Document listings never include `content` (`documents.ts:165`).
- `includeFiles` is opt-in because the file index is unpaginated (`documents.ts:88-90`).
- `PUT /documents/:documentId` omits `content` from its response, with an explicit note
  that echoing tens of MB back doubles serialization cost and blocks the event loop
  (`document.ts:555-563`).
- `headerImageAspectRatio` is computed only on single-document fetches, since it costs an
  image probe.

Vektor also has no GraphQL, which the post treats as the right default.

**Finding 10.1 — the opt-ins are ad-hoc rather than a convention.** `includeFiles`,
`draft`, `live`, `grouped`, and `rev` are five bespoke parameter names for "vary what you
give me." The post's suggested general form — a single `include=files,children` list —
would let the next expensive field be added without inventing a sixth. Not urgent, but
worth adopting before the sixth one arrives.

---

## 11. Errors

The post touches this only in passing (footnote 3: a 422 "typically means it failed during
the request-validation stage, before any action was taken"), so this section is short and
limited to places where Vektor contradicts its *own* documented contract — which is a
familiarity cost in the §1 sense.

`app/docs/api.md:36` states: *"Errors are always `{ "error": "message" }` with a matching
HTTP status."* Two places break that promise:

**Finding 11.1 — `GET /search` returns a plain-text 400.**
`routes/spaces/search.ts:54-57` throws `new Response("Invalid filters parameter: …",
{ status: 400 })` — a bare string body with no JSON content type. The published client
survives it only because `responseBody` falls back to raw text (`api/src/index.ts:200-205`).
Use `badRequestResponse()` like every other handler.

**Finding 11.2 — `POST /search/rebuild` returns a bare JSON string as its success body.**
`successResponse("Search embeddings rebuilt successfully")` (`search-rebuild.ts:24`) passes
the string through `jsonResponse`, so the body is `"Search embeddings rebuilt
successfully"` — a JSON string, not an object. Every other success body in the API is an
object. `successResponse()` with no argument gives `{ success: true }` and is almost
certainly what was meant.

**Finding 11.3 — mutation success bodies are spelled three ways.**
`{ success: true }` (most routes), `{ message: "Token revoked successfully" }`
(`access-token.ts:63,87`), and bare-string (11.2). Pick `{ success: true }` and use it
everywhere; a human-readable `message` in a success body is something no consumer should
be parsing anyway.

**Finding 11.4 — a duplicate slug returns 400, not 409.**
`CategorySlugTakenError` maps to `badRequestResponse` (`categories.ts:170`,
`category.ts:117`). A conflict with existing state is 409; 400 tells the consumer their
request was malformed, which sends them looking for a bug that is not there.

**Finding 11.5 — validation failures are 400 where 422 is the more useful signal.**
Per the post's footnote, 422 conventionally means "rejected at validation, before any
action was taken," which is exactly the information a client needs to decide whether a
retry is safe. This matters more once idempotency (§7) exists. Low priority, and it is a
breaking change to existing consumers — worth doing only if bundled with other work.

---

## 12. Internal APIs

> Internal APIs can take breaking changes and complex auth, because you can ship code for
> all consumers. But they still cause incidents and "still need to be idempotent for key
> operations."

This is the section that resolves the §2 tension, and it is why the public/internal split
proposed in Finding 2.1 is the right shape rather than a compromise. Note the part of the
post that does *not* get relaxed for internal APIs: idempotency on key operations, and
incident-proofing. `POST /workflows/runs` and `POST /jobs/run` are internal by that
definition and are exactly the "key operations" it names.

---

## What the post does *not* ask for

Worth stating explicitly, because these could otherwise look like gaps:

- **OpenAPI.** The post: *"I haven't mentioned OpenAPI schema — it's a useful tool, but I
  think it's also fine to just write your API docs in Markdown if you want."*
  `app/docs/api.md` is 990 lines of exactly that, per-endpoint, with auth models and error
  formats. No action needed. (A spec would buy drift-detection between server and the
  published client, but that is a testing argument, not this post's.)
- **GraphQL.** Explicitly discouraged. Vektor has none.
- **HATEOAS / REST purity.** Explicitly dismissed as the kind of advice that is "too
  fancy." `POST /search/rebuild` and `POST /jobs/run` being RPC-shaped verbs is fine.

---

## Recommended order of work

Ranked by consumer harm per unit of effort.

**Do first — cheap, and each one is a bug against a stated contract:**

1. `GET /search` plain-text 400 → `badRequestResponse` (11.1)
2. `POST /search/rebuild` bare-string body → `successResponse()` (11.2)
3. `GET /documents` `limit` → `parsePaginationParams` (9.3)
4. `total`/`limit` lying on the `categorySlugs`/`parentId` paths (9.2)
5. Duplicate slug → 409 (11.4)
6. Delete or adopt `PaginatedResult<T>` (9.4)

**Do next — real risk, moderate effort:**

7. Rate limits + `Retry-After`/`X-Limit-Remaining`, tighter buckets for `search/rebuild`,
   `chat/completions`, `url-metadata`, `proxy-media`, `jobs/run` (8.1)
8. Optional `Idempotency-Key` on `POST /documents` and `POST /workflows/runs` (7.1)
9. Write the public/internal compatibility split into `AGENTS.md` and `app/docs/api.md`
   (2.1)
10. Fix 401-vs-404 so the client's `isNotVisible` heuristic can be deleted (4.2)
11. Paginate `/revisions` and `/comments` before they need it and it is breaking (9.5)

**Do before v1 calcifies further — these are breaking, so bundle them:**

12. Move `?rev=N` to `/documents/:documentId/revisions/:rev` (1.1)
13. Move `{ restore: true }` out of PUT to `POST /documents/:documentId/restore` (1.2)
14. Drop the one-field-per-PATCH rule (1.3)
15. Settle one list envelope across all endpoints (9.1)
16. Resolve the `archived` slug shadowing (4.3)

Items 12–16 are all in the public half of the surface, which is the half that must not
break — so they get more expensive every release. That is the argument for deciding the
§2 split now rather than after the next consumer appears.
