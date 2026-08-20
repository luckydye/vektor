# Feasibility: moving `#db` and `#acl` into a Rust N-API module

Investigation only — no code changed. Conclusion up front: **not recommended as
a port.** The measurable win it targets is driver overhead, and that overhead is
recoverable in two files without an FFI boundary. What a port would additionally
buy is small; what it would cost is the two modules the whole application is
built on.

## What the two modules are

| | files | LOC | exported symbols |
|---|---|---|---|
| `src/db` | 34 | 8 707 | 306 |
| `src/acl` | 9 | 3 471 | 95 |

They are not leaf modules. `#db/client/store.ts` alone is imported at 92 sites,
`#db/client/query.ts` at 37, `#db/schema/space.ts` at 36. Across `src/`, `test/`
and `bench/` there are 375 imports of `#db/*` from 122 files and 197 imports of
`#acl/*` from 101 files — roughly 220 distinct files that would sit against the
new boundary.

The two are also mutually recursive: `src/db` imports `#acl/store.ts`,
`#acl/guards.ts`, `#acl/permissions.ts`, `#acl/userGroups.ts`, and
`#acl/instanceGroups.ts`; `src/acl` imports eight `#db/*` modules. Neither can
move without the other, which is why the question is correctly posed about both.

## The measurement

The premise worth testing is that a native data layer is faster. It is —
but almost none of that speed comes from Rust. SQL execution is already native C
in every option here; what differs is the cost of reaching it from JS.

Benchmarked locally: 10 000-row `document` table, WAL, file-backed, Bun 1.3.

| operation | `bun:sqlite` | `@libsql/client` | `drizzle` + libsql |
|---|---|---|---|
| point read by PK | **3.6 µs** (p50 2.8) | 103.7 µs (p50 96.9) | 128.6 µs (p50 118.6) |
| list 100 rows, indexed | **73 µs** (p50 60) | 331.7 µs (p50 278) | — |
| single insert (WAL fsync) | 213 µs | 228 µs | — |

Reads carry a fixed ~100 µs driver tax per statement — 29× on a point read.
Drizzle's builder adds a further ~25 µs. Writes are fsync-bound and show no
meaningful difference.

That table is the whole business case, and it does not argue for Rust. A
napi-rs module calling `rusqlite` would land in the same column as `bun:sqlite`:
both are native SQLite reached from JS across a binding, and napi's per-call
overhead is if anything slightly higher than Bun's internal bindings. **Swapping
the driver captures essentially the entire win a Rust port would.**

The one profiled hot spot in this repo points elsewhere anyway. `bench/README.md`
documents a realtime-collaboration hang investigated with `canvas-ops.mjs`,
timing `parseCanvasContent`, `seedCanvasDoc` and `encodeStateAsUpdate` — Yjs
work in `#realtime` / `#canvas`, not SQLite. `src/db` and `src/acl` contain no
yjs, prosemirror or tiptap imports at all.

## What blocks a port

**`#acl/permissions.ts` runs in the browser.** Fourteen Solid components
(`DocumentShareDialog`, `SpaceMembers`, `Navigation`, `Canvas`, …) import it, and
its header states the intent: the client "must reach the same verdict for the
role the server handed it". A `.node` addon cannot be bundled into the browser
build. This file — the permission vocabulary, the hierarchy, `resolveFeature` —
would have to stay in TypeScript regardless, or be duplicated in Rust with the
two copies kept in agreement, which is a security-relevant divergence risk in
exchange for nothing (it is pure string comparison; it is not slow).

**`#acl/guards.ts` mixes HTTP into the decision** — but only by co-location.
See "Re-cutting the boundary" below: this one is accidental, not structural.

**better-auth owns the auth database from JS.** `src/auth.ts` passes that handle
to `drizzleAdapter(authDb, { schema })`, so `auth.db` cannot move. Whether this
blocks anything depends on where identity ends and authorization begins — see
below; under a correct cut it does not.

**The transaction API passes JS callbacks into the driver** — under the current
shape. Also largely accidental; see below.

**`store.emit()` is a deliberate seam into `#realtime`.** `src/db/client/store.ts`
calls `sendSyncEvent` — its comment names it "the one place the data layer
touches the realtime layer". Realtime is WebSocket/Yjs and stays in JS, so a
Rust store would have to call back out on every write.

**Hosted libSQL.** `docs/db.md` documents `libsql://` / `https://` URLs with
`authToken` for remote space databases. The Rust `libsql` crate covers this, but
it is a second connection mode to port and test, not a freebie.

**Marshaling cost, from this repo's own precedent.** `native/exec` exposes 7
functions and still needed `marshal.rs` at 394 lines. `#db` + `#acl` export ~400
symbols returning row objects with `Date`, nullable columns and JSON payloads.
Every one crosses as a serialize/deserialize — which eats into the same ~100 µs
budget the port set out to reclaim.

**Build and release.** The matrix already builds three Rust addons per platform
(`.github/workflows/release.yml`, `docker.yml`) and ships only `linux-x64` and
`darwin-arm64`. A fourth addon is not new infrastructure — that part is genuinely
solved here — but it does put the data layer behind a Rust toolchain for anyone
running `task dev`, and a `cargo` build failure becomes "the app cannot read its
database" rather than "image resizing is unavailable".

## What is favourable

Being fair to the idea:

- **The driver seam is already tight.** Only `connection.ts:137` touches
  `$client`; every read goes through `one`/`many`/`exec` in `query.ts` (237 call
  sites). `resolveSpaceLocation` is documented as the single place a dialect is
  interpreted. Whoever wrote this left the door open for exactly this kind of
  swap.
- **No JS-only libraries are entangled in the data layer.** Outbound deps are
  drizzle, `@libsql/client`, `node:crypto`, `#config` and the logger. Nothing in
  `#db`/`#acl` needs a JS runtime the way the canvas layer does.
- **Schema leakage is smaller than the import count suggests.** Only 12 files
  outside `src/db` import `#db/schema/space.ts`, three of them tests.
- **Coverage is strong where it matters.** `permission-escalation`,
  `route-access-matrix`, `credential-public-grants`, `wiki-roles.acceptance`,
  `frontend-acl`, `readonly`, `revision-*-access` — a port would at least be
  verifiable rather than a leap.
- **`src/db/secretsCrypto.ts`** (78 lines, AES-256-GCM) is the one file that is a
  natural Rust fit on its own merits, and it is also the one whose migration
  nobody would notice.

## Re-cutting the boundary

The blockers above are not equally real. Four of them are artefacts of where
code currently sits, not of what it does. Separated honestly:

### Accidental — a correct cut removes them

**The `Response` coupling is already cut, just co-located.** `decideAccess`
(`guards.ts:118`) returns `{ decision: "ok" | "no-space" | "no-document" |
"denied", requiredRole }` — a tagged union, no HTTP. `denialResponse` (`:186`)
translates it, and its own comment says why they are separate: "the 401/403
split below is presentation, and reading it back off a thrown Response confuses
'not allowed' with 'not authenticated'." The decision core is already portable;
it just lives in the same file as its adapter.

**The Hono coupling is six header reads.** `ApiContext` appears at six points in
`guards.ts` and is used for exactly three things: `X-Job-Token`, `Authorization`,
and `context.var.user`. A `{ jobToken?, bearer?, sessionUserId? }` struct
replaces it, and the `authenticate*` family splits into a request-edge adapter
(JS) over a credential-resolution core.

**Transactions are already DB-only.** The 10 `tx()` blocks were the strongest
structural objection, and they do not hold up. `deleteDocument` collects file
paths inside the transaction and calls `getFileStorage().delete()` *after* it.
`scheduleDocumentSearchRefresh` is fire-and-forget (`void … .catch`), outside the
commit. Nothing inside a transaction calls embedding, storage, or Yjs. The one
genuine violation is `api/routes/spaces/permissions.ts:320`, which throws
`forbiddenResponse()` and returns `jsonResponse()` from inside `store.tx()` —
fix that one and a transaction becomes a pure unit of work that fits entirely
inside a native module. **No JS callbacks required.**

**`store.emit()` already has the right shape.** It buffers `SpaceChange[]` and
publishes only on commit. A native store returns the change list; JS publishes
it. That is a cleaner seam than today's, not a worse one.

**Identity vs. authorization is separable, and separating it is an improvement.**
`decideAccess` already threads `groups` as a parameter into `hasPermission`.
Only four functions in `acl/store.ts` touch the auth database —
`getUsersInSharedGroups`, `resolveGranteeName`, `getSpaceMemberIds`,
`getSpaceMembersWithGroups` — and all four are directory/presentation, not
decisions. The decision core (`hasPermission`, `getPermission`,
`getDocumentPermission`, `hasFeature`, `hasAnyResourceScopedAccess`,
`listAccessibleResources`, `filterReadableResources`) reads only the space `acl`
table plus a groups array handed to it. better-auth keeps `auth.db`; the core
never touches it.

That last split fixes a real latency bug on the way: `getUserGroups` calls
`ensureFreshGroups`, which can make an IdP HTTP round-trip — and it is reached
from inside `decideAccess`, and again from `isInstanceAdmin` within the same
decision. Hoisting identity resolution to the request edge resolves groups once
per request instead of twice-or-more per permission check.

### Structural — a correct cut relocates them, it does not remove them

**The permission hierarchy has to exist on both sides of the FFI.**
`PERMISSION_HIERARCHY` and `DEFAULT_FEATURES` are read at 16+ points inside
`acl/store.ts`, including `permissionsAtLeast` which builds SQL `WHERE`
clauses — so a native decision core must own them. Fourteen browser components
import the same table from `permissions.ts`, and a `.node` addon cannot be
bundled for the browser. One of the two copies must be generated from the other
(napi already emits `index.d.ts`; emitting the constants too is a small extra
step) or served as data. Solvable, but it introduces a security-relevant
invariant that is currently free.

**The benchmark.** Unchanged, and it is the load-bearing argument. Cutting the
boundary correctly makes a port *tractable*; it does not make it *worth* more
than it was. ~100 µs per read of driver tax is the entire prize, and `bun:sqlite`
collects it without an FFI.

**Width.** ~400 exported symbols across ~220 files. Correct boundaries reduce the
awkwardness of the crossing, not the number of crossings.

### What this changes

The verdict moves from "no" to **"the refactor is worth doing on its own merits;
do it, and the port becomes a reversible decision instead of a big-bang one."**

The refactor stands alone — guards split into decision core and HTTP adapter,
identity resolution hoisted to the request edge, transactions as domain units
with no HTTP inside, `emit` returning changes rather than calling realtime. Every
one of those is a better design in TypeScript, today, with no Rust in the picture.

And once it is done, the port stops being all-or-nothing. `acl/store.ts` alone —
1 889 lines, the hottest read path, self-contained against the space database
once the four directory functions move out — could go behind a napi module and be
measured, without touching `#db` at all. That is the shape `native/exec` and
`native/embedding` already have. If the numbers justify it there, `#db` follows;
if they do not, nothing was lost.

Note the ordering that implies: **port `#acl` first, not `#db`.** The original
framing had it backwards. `#db` is IO-bound and wide; the ACL decision core is
CPU-and-query-bound, narrow, and the one place where per-request latency
compounds — every route passes through it, sometimes several times.

## Post-merge update (#194)

The refactor landed as `a6f5af9`. It changes the feasibility answer in both
directions at once, and turned up a number that settles it.

### The port is now genuinely easy

`decideAccess` takes a `ResolvedIdentity` and can no longer look anything up —
the type enforces it. Its whole signature is now values:

```ts
decideAccess(spaceId: string, target: { type, id, anyGrantInSpace? },
             identity: { userId, groups, isInstanceAdmin },
             requiredRole: Permission) -> { decision, requiredRole }
```

Strings, a string array, two booleans, a tagged enum out. No `Date`, no row
objects, no callbacks — the marshaling problem that made `#db` unattractive does
not exist here. `store.ts` lost ~409 lines to `directory.ts`, so the decision
core reads only the space `acl` table. `identity.ts` keeps better-auth and the
IdP sync on the JS side of the line. This is the `native/exec` shape exactly.

### And most of the reason to do it is gone

The refactor banked the win: group resolution — with a possible outbound IdP call
— happened twice per decision and now happens once per request, memoized through
`AsyncLocalStorage`. That is worth far more than the ~100 µs/query driver tax the
port was aiming at, and it is already collected.

### The number that settles it

`getDocumentAncestorIds` (`acl/store.ts:524`) walks the document tree in
application code, and to do it reads the whole table:

```sql
SELECT id, parent_id FROM document      -- no WHERE clause
```

It is called on every document access decision, from three sites. Measured on a
30 000-document space — the size `bench/seed-space.ts` produces by default:

| ancestor walk, per decision | |
|---|---|
| today: full scan via `@libsql/client` | **61.2 ms** (p50 50.7, p99 212) |
| same query, native marshaling (`bun:sqlite`) | 15.5 ms (p50 12.5) |
| `WITH RECURSIVE` via the driver already in use | **0.16 ms** (p50 0.15) |

The recursive CTE returns 4 rows instead of 30 000.

So on the hottest path in the module, the entire prize a native rewrite could
win is ~45 ms, and fixing the query wins ~61 ms — through the existing driver,
in one function, with no FFI and no toolchain. The language was never the cost.

**Verdict after the refactor: the same answer, held more firmly, and for a better
reason.** The port is now cheap to attempt and cheap to reverse, which is the
right place for it to sit — but the ACL path has a 380× query fix in it, and the
data layer has a 25× driver swap. Both are ordinary TypeScript. Exhaust those
before spending a Rust boundary on a 4× that is measured against the wrong
baseline.

### Loose ends from the merge

- `#api/acl.ts`, which the commit message names as the seam that turns a decision
  into a 401/403/404, does not exist. `denialResponse` is still in `guards.ts`
  (`:172`) and `guards.ts` still imports `#api/http.ts` (`:45`). The valuable half
  landed — nothing in `guards.ts` takes a Hono context, and `CallerCredentials`
  is built once per request — but the Response translation did not move.
- The `anyGrantInSpace` branch gained `&& effectiveRole === requiredRole`, so
  presence in a space no longer satisfies a bar an archived document raised.
  That is a tightening and a good one, but it is a permission-model change and the
  commit says there was none. It wants a regression test naming it.
- The root `*credentials*` ignore rule that swallowed `acl/credentials.ts` is
  still on `main`; the merge worked around it by folding the struct into
  `guards.ts`. The next file named for the concept hits the same trap.

## Recommendation

**Take the driver first, and the refactor for its own sake.** Route local file-backed databases through
`bun:sqlite` and keep `@libsql/client` for `libsql://`/`https://` URLs. The
branch belongs in `resolveSpaceLocation`/`createDatabase`, which is where the
dialect distinction is already documented to live, and `query.ts` absorbs the
result-shape difference — it exists for that. Expected: point reads ~104 µs → ~4 µs,
100-row lists ~332 µs → ~73 µs, writes unchanged. Two files touched instead of
~220, no FFI, no second toolchain on the read path, `#acl/permissions.ts` stays
in the browser bundle where it has to be.

Separately — and independently of any native work — make the cuts described in
"Re-cutting the boundary". They are better TypeScript on their own, and they turn
a possible future port from a big-bang migration into an incremental one whose
first step is `acl/store.ts`, not `#db`.

If both land and profiling still shows a data-layer bottleneck, the honest next
targets are narrow, computational, and can be taken one at a time behind the
existing `#native/*` pattern:

1. **Search ranking / embedding** — `#search/ranking.ts` already sits next to a
   Rust embedding addon; scoring candidates is real CPU work over many rows.
2. **`secretsCrypto.ts`** — self-contained, 78 lines, no boundary problems.
3. **Bulk ingest paths** — `bench/seed-space.ts` documents that going through
   `createDocument` costs "minutes of work per thousand documents". A native bulk
   writer is a defensible addon; it is also mostly an N+1 problem worth fixing in
   TypeScript first.

Each of those is the shape `native/exec` and `native/embedding` already are:
a narrow function-level API over CPU-bound work, with the orchestration left in
TypeScript. Moving `#db` and `#acl` wholesale is the opposite shape — a wide,
chatty, IO-bound, HTTP- and browser-entangled boundary — and the benchmark says
it would be bought at that price for a speedup a driver swap already delivers.
