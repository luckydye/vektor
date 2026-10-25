# Hosting Vektor on Cloudflare (one Durable Object per space)

Gap analysis from reading the code; nothing was built or run. Cloudflare limits (bundle size, DO storage caps, row size) were not re-verified and should be checked before committing to a design.

No Cloudflare code exists yet. The only traces are comments in `platform.ts`, `transactionScope.ts` and `connection.ts` that already assume "one Durable Object per space". What is missing is a second `Platform` implementation, a Workers entry point, and a few features that need a different design.

## Target infrastructure

One Worker is the whole Vektor instance. Each space is a Durable Object with its own SQLite; everything else is a binding.

```
 Browser / CLI / API clients
          │  HTTPS + WebSocket
          ▼
 ┌─────────────────────────────────────────────┐
 │ Worker  (the vektor instance)               │
 │  Astro SSR + static assets, auth, routing   │
 │  routes each space request to its SpaceDO   │
 └───────┬──────────────┬───────────────┬──────┘
         │              │               │
         ▼              ▼               ▼
 ┌──────────────┐ ┌────────────┐ ┌────────────────┐
 │ SpaceDO      │ │ InstanceDO │ │ R2             │
 │ one per space│ │ one per    │ │ uploads,       │
 │ space API,   │ │ instance:  │ │ caches         │
 │ SQLite, WS,  │ │ users,     │ └────────────────┘
 │ alarms       │ │ sessions,  │  optional: Workers AI,
 └──────────────┘ │ space_index│  Images, email
                  └────────────┘
```

The Worker authenticates against the InstanceDO, resolves the space, and hands the request to that space's DO. The space-scoped Hono API, SQLite, realtime and background work all run inside the DO. Cross-space reads (space list, cross-space search) use the index in the InstanceDO rather than fanning out to every DO.

Out of scope for a first cut, each needing its own design (see Gaps §5–6): the job VM / `exec`, the agent worker, the Discord bot, and git hosting.

## Already in place

- **`Platform` interface** (`server/src/platform/platform.ts`) puts every host-specific concern behind one interface per concern. Only `platform/bun/*` implements it.
- **`SpaceDatabase`** is addressed by space ID, with `open/allocate/archive/purge`. `transaction` is documented as "as atomic as this storage allows".
- **`SpaceHost.at(spaceId, time)`** is documented as "one process, or one DO each". On Workers it maps to `ctx.storage.setAlarm`. `runSpaceWork` is already a single pass that reports when it is next due.
- **`SpaceStore`** is the only data-layer entry point. `assertOutsideTransaction` already enforces that no external I/O runs inside a transaction.
- **`getAuthDb`** treats the global database as a separate object from the space, and refuses to run inside a space transaction. That already fits the InstanceDO.
- **Repositories** go through `one`/`many`/`exec`, so they are driver-agnostic.

## Gaps

### 1. Space storage

- Implement `SpaceDatabase` over a DO namespace binding (`idFromName(spaceId)` plus RPC). Inside the DO, use drizzle's `durable-sqlite` driver.
- That driver is synchronous and DO SQLite forbids `BEGIN`. `store.tx()` needs a `transactionSync`-style implementation. This works only if transaction bodies await nothing but DB calls. Audit the 9 `transaction(` call sites.
- `openSpaceStore` currently runs on the caller's side, in the request path. On Workers the repository code must run inside the DO, otherwise every query is an RPC. This matches the diagram: the Worker handles assets, auth and routing by space ID, and space-scoped API handlers run in the DO.
- Pragmas: `local: false` already skips WAL and `synchronous`; `foreign_keys` is on by default. `VACUUM` in purge is unsupported, so purge becomes `deleteAll()`.
- Run the migrator on DO start inside `blockConcurrencyWhile`. The "already migrated" cache is irrelevant there.
- `space_index.location` and the encrypted per-database token columns do not apply to DOs.

### 2. Global / auth database (InstanceDO)

- Users, sessions, accounts, OAuth tables, `jwks` and `space_index` move to a single `InstanceDO` with its own SQLite, using the same drizzle `durable-sqlite` driver as the spaces. `GlobalDatabase.open()` returns that. No second SQL dialect or storage service.
- Users cannot move into the space databases: they are instance-wide and belong to many spaces, and login happens before any space is known. Memberships (`acl`) are already per space.
- better-auth's `drizzleAdapter` needs an in-process database. Run the auth routes inside the InstanceDO (forwarded by the Worker). A drizzle `sqlite-proxy` over RPC is the alternative, but transactions are awkward there.
- Every request checks a session, so all traffic would funnel through one single-threaded object. Mitigate with better-auth's cookie cache or signed session cookies, and cache slug-to-space lookups in the Worker.
- `prepareAuthDb` generates `CREATE TABLE` on every boot via `generateCreateTableSQL`. In the InstanceDO this should become real migrations run under `blockConcurrencyWhile`, like the space migrator.
- Several features read across spaces: `listActiveSpaceIds`, `listIndexedSpaces`, `search/crossSpace.ts`, `db/space/spaces.ts:283`, `discordBot`, the startup sweeps in `server.ts` (~216, ~345) and `api/ReplicaDb.ts`. Each opens N spaces in one process. On DOs that is N RPCs, a fan-out, or a denormalized index in the InstanceDO. `IndexedSpaceMetadata` is the natural place to extend.

### 3. Realtime (largest piece)

- `realtime/*` keeps in-memory process singletons: `yRooms`, the `listeners` set in `events.ts`, `changeLog` histories, presence maps, persist timers. They are already keyed per space, so each DO can host its own copy.
- The `ws` server attaches to Node's `http.Server`. On Workers it needs `WebSocketPair`, ideally with the hibernation API (`ctx.acceptWebSocket`). `acceptRealtimeConnection` should be reusable, since it takes a socket plus `Headers`.
- Hibernation drops in-memory Y.Doc and room state, so rooms must rebuild from the persisted snapshot on wake. Without hibernation, DOs with idle sockets bill for duration.
- Isolation is per space but Yjs rooms are per document, so every document's room and persist debounce shares one DO thread.
- `setInterval` sweeps and `setTimeout` persist debounces must move to alarms, or flush before eviction.

### 4. Entry point and HTTP stack

- `server.ts` is Node-specific (`createServer`, `IncomingMessage` conversion, `sendWebResponse`, filesystem/embedded asset middleware, `setInterval` sweeps). A `worker.ts` is needed with `fetch`, `alarm` and the DO class. Hono runs on Workers unchanged.
- Astro uses `@astrojs/node` with `output: "server"`. It needs `@astrojs/cloudflare`, static assets via the assets binding, and a replacement for `/_image`.
- Config reads `process.env`. Use `nodejs_compat` and wire `vars`/secrets through.
- Bundle size is a risk: Tiptap/ProseMirror, IronCalc wasm, Yjs and better-auth all go in.

### 5. Platform components

| Component | Bun now | Cloudflare path |
|---|---|---|
| `blobStore` | local disk / S3 | R2 binding (the S3 store may already work against R2's S3 API) |
| `transformCache` | local disk | R2 or Cache API |
| `jobCache` | disk LRU | DO storage or R2 with TTL eviction |
| `imageTransformer` | napi Rust | Cloudflare Images, or return `null` (already supported: originals are served) |
| `embedder` | napi ONNX | Workers AI model. A model change invalidates stored vectors; the model string is stored beside each, so staleness is detected. `.node` files cannot load. |
| `jobVm` | Boa via napi + `exec` | Worker Loader isolates or Containers. Needs a new capability host. `exec` of `pandoc`/`htmlq`/`rsvg-convert` needs Containers or is dropped. |
| `docSerializer` | worker pool | In-DO (no `worker_threads`) |
| `passwordHasher` | `Bun.password` | WebCrypto PBKDF2/scrypt. Existing hashes are incompatible, so `verify` needs a format switch. |
| `mailer` | SMTP (nodemailer) | Email Service or an HTTP provider. Raw TCP SMTP is not possible. |
| `fetch` (SSRF guard) | Bun DNS checks | Verify what the guard relies on; Workers `fetch` cannot resolve DNS first. |
| `git` | git binary + disk | Already nullable. Git hosting unavailable unless reimplemented. |
| `localJobFiles` | reads `./jobs` | Empty |

### 6. Other

- `agent/` runs in a Bun worker (`stopAgentWorker`). It needs to become a DO or Workflow, and sub-agent state needs a durable home.
- The Discord bot holds long-lived gateway connections and needs a dedicated DO.
- Metrics (Prometheus) and the logger use Node APIs.
- `AsyncLocalStorage` works under `nodejs_compat`, so the transaction scope carries over.
- DO SQLite caps (per-DO size, per-row/blob size, no extensions) should be checked against the `blob("snapshot")` columns and embedding storage.

## Suggested order

1. Spike the DO `SpaceDatabase` with `transactionSync` and run the existing server test suite against it.
2. Write the Worker + DO entry (HTTP routed per space, auth in the InstanceDO), swapping in R2 and no-op image/embedding.
3. Port realtime to hibernating WebSockets plus alarms.
4. Add the cross-space index in the InstanceDO, then the mailer and password hasher.
5. Later, each needing its own design: job VM / `exec`, agent worker, Discord bot, git hosting.

Biggest risks for the first cut: the realtime port and the cross-space fan-out. The job VM is the biggest risk after it.
