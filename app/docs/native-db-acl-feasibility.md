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

**`#acl/guards.ts` is HTTP, not logic.** 896 lines that resolve a request's
credential (job token, access token, session, none) and *throw `Response`
objects* so a route that forgets the failure path fails closed. It reaches into
`#api/http.ts`, `#api/server/types.ts`, `#auth` (better-auth), and `#jobs/jobToken.ts`.
Constructing and throwing Web `Response` from Rust is not a boundary worth
drawing; the guard layer belongs on the JS side of any split.

**better-auth owns the auth database from JS.** `src/auth.ts` passes the same
handle to `drizzleAdapter(authDb, { schema })`. Rust cannot take ownership of
`auth.db` without either reimplementing better-auth's adapter or leaving two
independent writers on one file — and `#acl/store.ts`, `#acl/idpSync.ts` and
`#db/auth/spaceIndex.ts` all query the auth DB.

**The transaction API passes JS callbacks into the driver.** `SpaceStore.tx(fn)`
runs `fn` against a transaction-scoped store and buffers realtime events until
the commit lands. Under a Rust-owned connection every such callback re-enters
Rust from the JS thread while a transaction is open — re-entrancy plus threaded
`ThreadsafeFunction` plumbing for the 10 current call sites, replacing something
that is 40 lines of TypeScript today.

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

## Recommendation

**Take the driver, not the rewrite.** Route local file-backed databases through
`bun:sqlite` and keep `@libsql/client` for `libsql://`/`https://` URLs. The
branch belongs in `resolveSpaceLocation`/`createDatabase`, which is where the
dialect distinction is already documented to live, and `query.ts` absorbs the
result-shape difference — it exists for that. Expected: point reads ~104 µs → ~4 µs,
100-row lists ~332 µs → ~73 µs, writes unchanged. Two files touched instead of
~220, no FFI, no second toolchain on the read path, `#acl/permissions.ts` stays
in the browser bundle where it has to be.

If that lands and profiling still shows a data-layer bottleneck, the honest next
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
