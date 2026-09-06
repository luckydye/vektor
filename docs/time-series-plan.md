# Time-series data in a space

A place for points that carry their own time and are never edited: GPS tracks,
device telemetry, workflow and app logs. They are written by appending, read
back as a range, and forgotten by age rather than deleted by hand.

The points themselves live in object storage — the S3 or local-filesystem
adapter behind `#files/storage.ts` — as immutable, compressed, columnar
**chunks**. The space database holds only the mutable half: what series exist,
which chunks each one has, and the short unsealed tail that has not been packed
into a chunk yet.

## Why chunks in storage, and not rows in SQLite

A row per point is the obvious design and the wrong one here. A year of one
device at 1 Hz is 31M rows in a file that also serves documents, editor
revisions and search; retention means deleting them a million at a time; and
every byte sits in the backup and the vacuum of a database whose interesting
content is four orders of magnitude smaller. Points are also the one thing in
the product that is written once, never updated, and read in contiguous
time order — which is exactly what an immutable object is good at holding.

**This is the git subsystem's architecture, reused.** `#git/state.ts` and
`#git/publish.ts` already keep immutable packs in storage under a per-repository
prefix, name the live ones from a single mutable manifest, treat the local
directory as a cache that loses nothing when deleted, and sweep objects no
manifest names. Series differ from it in one respect, deliberately: the manifest
is SQLite rows rather than a `state.json` written with `putConditional`. Git can
put its manifest in storage because a push's objects are durable before the
manifest flips. An append cannot — a log line has to be durable the moment it
arrives, which means the hot tail is in the database, and sealing has to move
rows and add a chunk in one atomic step. That step is a SQLite transaction; it
has no equivalent across two storage objects.

## What exists already, and why none of it is the place

- **`audit_log`** has the right query shape — autoincrement id, a
  `(ts DESC, id DESC)` index, seek cursors — and the wrong scope: `doc_id` is
  `NOT NULL`, `event` is a closed union in `#db/space/auditLogs.ts`, and nothing
  ever removes a row. Its cursor code is the template the unsealed tail copies.
- **A `database` document with `record` children** already stores structured
  rows. One point through that path costs a `document` row, a `property` row per
  field, a `change_seq` allocation (the space's single write counter, taken
  under SQLite's write lock), a document-tree broadcast, and a search-index
  entry.
- **Workflow run logs** are the closest existing thing to a chunk: an
  in-memory array flushed to one `artifacts/workflow/{runId}/logs.json` object
  at the end of the run (`#jobs/runStore.ts`, `#jobs/workflowArtifacts.ts`).
  One object per run, written once, read whole. Generalising that is most of
  this design; see the last section.
- **Editor revisions** compress a snapshot with async brotli on libuv's
  threadpool, with a comment in `#db/space/revisions.ts` about what synchronous
  zlib did to Bun's event loop. Chunk encoding follows it exactly.

## The chunk format

One chunk is one object: a time-ordered, columnar, brotli-compressed JSON
document. Columnar because a chunk is decoded whole and because columns of like
values are what makes a compressor earn its keep — and because
`JSON.parse` over a handful of arrays is a different order of cost from parsing
50 000 small objects.

```jsonc
{
  "v": 1,
  "seriesId": "series_…",
  "count": 5000,
  "t0": 1764547200000,        // first timestamp, absolute
  "dt": [0, 1000, 1000, 999], // deltas from the previous point
  "labels": [0, 0, 1, 0],     // dictionary indices, omitted when unlabelled
  "labelDict": ["info", "error"],
  "columns": {                // one array per field seen, nulls where absent
    "lat": [52.51, 52.51, …],
    "lon": [13.37, 13.37, …]
  }
}
```

Columns are discovered from the points, not declared per kind: a writer that
adds a field gets a new column, and older chunks simply lack it. Timestamps are
deltas so a steady sample rate compresses to almost nothing. `v` is in the
document because the format will change — a binary v2 with a footer offset
table, so `readStream`'s `ByteRange` can pull one column or one time slice
without fetching the chunk whole, is the obvious next step and needs no change
to anything indexing it.

Chunks are named deterministically from what they contain, under a prefix of
their own:

```
series/{seriesId}/{paddedFromMs}-{lastRowId}.tsc.br
```

Deterministic because that is what makes sealing idempotent: a seal retried
after a crash re-encodes the same rows, produces the same key, and
`putConditional(…, { ifNoneMatch: true })` reports the conflict instead of
writing twice. The `series/` prefix keeps chunks out of the uploads listing and
the file search index, for the reason `workflowArtifactKey` documents about
artifacts — and `list()` without a prefix only walks the content-addressable
uploads layout anyway.

## Schema

Three tables in `#db/schema/space.ts`, created by migration `3`. None of them
holds a point at rest.

```ts
export const series = sqliteTable(
  "series",
  {
    id: text("id").primaryKey(),
    /** The stable handle a writer addresses, e.g. "gps:vehicle-7". */
    name: text("name").notNull(),
    /** Payload shape: "gps" | "log" | "metric". Picks the validator and the view. */
    kind: text("kind").notNull(),
    /** Owning document; the series, its chunks and its tail go with it. */
    documentId: text("document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    /** Retention window in days. Null keeps chunks until the count cap evicts them. */
    retentionDays: integer("retention_days"),
    /** Ceiling on sealed chunks; the sweep drops the oldest above it. */
    maxChunks: integer("max_chunks").notNull().default(1000),
    /** Points a chunk is sealed at, and the age that seals a slow one anyway. */
    chunkPoints: integer("chunk_points").notNull().default(5000),
    chunkMaxAgeSeconds: integer("chunk_max_age_seconds").notNull().default(3600),
    /** Held by the process currently sealing this series' tail; see `sealSeries`. */
    sealingAt: integer("sealing_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("series_name_unique").on(t.name)],
);

/** One row per sealed chunk object: the index a range query is answered from. */
export const seriesChunk = sqliteTable("series_chunk", {
  id: text("id").primaryKey(),
  seriesId: text("series_id")
    .notNull()
    .references(() => series.id, { onDelete: "cascade" }),
  /** Storage key of the chunk object, under the space's `series/` prefix. */
  key: text("key").notNull(),
  /** Inclusive time span of the points inside, so overlap is one indexed range. */
  fromTs: integer("from_ts", { mode: "timestamp_ms" }).notNull(),
  toTs: integer("to_ts", { mode: "timestamp_ms" }).notNull(),
  count: integer("count").notNull(),
  /** Compressed size, so a read can refuse a range before fetching it. */
  bytes: integer("bytes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * The unsealed tail: points that have arrived and are not in a chunk yet.
 *
 * Bounded by `chunkPoints` per series rather than by retention — a row here
 * lives for seconds to an hour. This is the only table an append writes.
 */
export const seriesTail = sqliteTable("series_tail", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seriesId: text("series_id")
    .notNull()
    .references(() => series.id, { onDelete: "cascade" }),
  /** The event's own time, from the writer — not when the server received it. */
  ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  /** One low-cardinality tag: a log level, an event name. */
  label: text("label"),
  /** The point as JSON; the columnar layout is the chunk's business, not the row's. */
  data: text("data").notNull(),
});
```

Indexes, written as raw SQL in the migration the way the baseline writes
`audit_log`'s, so their direction matches the queries:

```sql
CREATE INDEX IF NOT EXISTS series_chunk_series_span_idx
  ON series_chunk (series_id, from_ts, to_ts);
CREATE INDEX IF NOT EXISTS series_tail_series_ts_idx
  ON series_tail (series_id, ts, id);
```

Decisions worth recording, so they are not reopened by accident:

- **`timestamp_ms`, not `timestamp`.** Every other table stores seconds; a
  position at 1 Hz and two log lines in the same millisecond need more.
  `schemaUtils.getSQLiteType` already maps it to `INTEGER` affinity.
- **The tail is a row per point, and that is fine.** It is a staging area whose
  size is `chunkPoints × open series`, not a history. Ingest stays one indexed
  insert, transactional with everything else a request writes.
- **`(ts, id)` on the tail, `(from_ts, to_ts)` on the index.** Two log lines in
  one millisecond are ordinary, so `ts` alone cannot order the tail; a range
  query never scans points, only spans.
- **A declaration table.** Retention, chunk sizing and the seal claim need
  somewhere to live, and a point naming an undeclared series is refused — which
  is what stops a buggy extension from minting unbounded stream names.
- **`name` is unique per space**, with an optional `documentId` for ownership.
  A series belonging to a document dies with it by the cascade; a space-level
  one (a fleet's positions, the instance's own logs) has no document to hang
  from. The cascade drops rows, so the sweep is what deletes the objects.

## Sealing

The one operation with an ordering that matters.

1. Claim the series: `UPDATE series SET sealing_at = ? WHERE id = ? AND
   (sealing_at IS NULL OR sealing_at < ?)`, then read `sealing_at` back and
   proceed only if it is ours — the compare-and-swap-and-verify
   `claimMigrationLock` uses, for the same reason, with a TTL so a process that
   dies mid-seal does not park the series forever.
2. Read the tail rows for the series in `(ts, id)` order.
3. Encode them into a chunk and `putConditional(…, { ifNoneMatch: true })`. A
   conflict means a previous attempt already uploaded this exact chunk, which is
   success, not failure.
4. In one transaction: insert the `series_chunk` row and delete exactly the tail
   ids that went into it.
5. Release the claim.

The object is durable before any tail row is deleted, and the index row and the
deletion commit together. A crash between 3 and 4 leaves an orphaned object and
an intact tail, so the next seal redoes it and lands on the same key. A crash
after 4 leaves nothing to do. Nothing is ever acknowledged to a writer and then
lost, and no point can be in a chunk and in the tail at once.

`sweepOrphanedChunks` handles what step 3 can strand, modelled directly on
`sweepOrphanedPacks`: list the series prefix, delete objects no `series_chunk`
row names and whose `updatedAt` is past a grace period, so a chunk uploading
right now is never mistaken for a leak.

Seals are triggered from two places: an append that pushes the tail past
`chunkPoints` schedules one, and the cron tick seals tails older than
`chunkMaxAgeSeconds` so a series receiving a point a minute still becomes
readable-as-chunks eventually.

## Repository: `app/src/db/space/series.ts` and `app/src/series/chunks.ts`

Split along the boundary the codebase already draws: the repository owns rows
and takes a `SpaceStore`; the chunk module owns the format and the storage
adapter and knows nothing about routes.

`chunks.ts`:
- `encodeChunk(points)` / `decodeChunk(buffer)` — the format above, brotli
  compression via `promisify(brotliCompress)` at a quality that drops for large
  payloads, exactly as `compressRevisionContent` does and for the same reason.
- `chunkKey(seriesId, fromTs, lastRowId)` — deterministic, as above.
- `readChunk(spaceId, key)` — through an LRU of decoded chunks. Chunks are
  immutable, so the cache needs no invalidation and no etag check; it is capped
  by decoded bytes, and dropping it loses nothing.

`series.ts`:
- `createSeries`, `getSeriesByName`, `getSeries`, `listSeries(store, { documentId })`,
  `updateSeries`, `deleteSeries` (rows cascade; the objects go on the next sweep).
- `appendPoints(store, seriesId, points)` — one transaction, one multi-row
  insert into the tail, bounded by `SERIES_MAX_BATCH`. Throws when the series is
  unknown; there is no implicit create, because that is the cardinality guard.
- `sealSeries(store, seriesId)` / `sealDueSeries(store, now)` — the five steps.
- `querySeriesPoints(store, seriesId, { from, to, label, limit, cursor })` —
  select overlapping chunks from `series_chunk`, decode them in order, then the
  tail rows, filter and merge. The cursor is the existing `encodeSeekCursor`
  with a string id: `{chunkId}:{offset}` inside a chunk, `tail:{rowId}` in the
  tail, so a page boundary is exact wherever it falls.
- `latestPoint(store, seriesId)` — the map pin and the "last seen" label. Reads
  the tail first and only touches a chunk when the tail is empty.
- `pruneSeries(store, now)` — retention: delete the objects for chunks whose
  `toTs` is past the window, and the oldest chunks above `maxChunks`, then their
  rows. One storage delete per chunk instead of per point, which is the whole
  point of the layout.

Appends never call `nextChangeSeq` or `touchDocument`. A point is not a document
edit: taking the space's write counter per point would serialise every writer
behind the write lock and invalidate every document's entity tag.

## Realtime

`SpaceChange` gains one variant in `#realtime/changes.ts`:

```ts
| { kind: "series"; seriesId: string; documentId: string | null; latestTs: number; count: number }
```

mapped to `realtimeTopics.series(seriesId)` and, when the series has one, the
owning document's topic. Emitted once per append call rather than once per
point, and it carries counts, not data — clients refetch the range they are
showing, as everywhere else in the sync layer. `store.emit` inside `tx` already
holds the event until the commit lands. Sealing emits nothing: it moves points
between two places that a read already merges, and a client that heard about
them has nothing to do differently.

## API

Registered in `#api/routes.ts`, documented by the JSDoc tags the OpenAPI
generator reads:

| Route | Methods | Role |
| --- | --- | --- |
| `/api/v1/spaces/[spaceId]/series` | `GET`, `POST` | list / declare |
| `/api/v1/spaces/[spaceId]/series/[seriesId]` | `GET`, `PATCH`, `DELETE` | read / retention / remove |
| `/api/v1/spaces/[spaceId]/series/[seriesId]/points` | `POST` | append a batch |
| `/api/v1/spaces/[spaceId]/series/[seriesId]/points` | `GET` | range query (`from`, `to`, `label`, `@paginated`) |

Access follows what the series is attached to: with a `documentId`, the verdict
is that document's through `verifyAccess(… ResourceType.DOCUMENT …)`; without
one, the space's. Reads need `Permission.VIEWER`, writes `Permission.EDITOR`. No
new `Feature` — nothing here is grantable independently of the role.

The append route authenticates through `authenticateJobTokenOrSpaceRole`, so a
workflow's job token and a device's space access token both reach it, and it
goes through the existing `apiRateLimiter`. Every new route needs its row in
`app/test/snapshots/route-access.md`, which snapshots the access matrix for
every registered route.

Chunk objects are never served directly. They are an internal encoding, they
hold many points at once with no per-point access control, and the URL a
storage adapter hands out can be a redirect to the bucket — so reads go through
the points route, which is also the only place that can merge the tail in.

Workflow scripts need no new capability: `apiFetch` already reaches this
instance's API authenticated as the run.

## Sweeps

Two more due-checks in `cronScheduler.tick()`, beside `purgeExpiredSpacesIfDue`
and shaped like it — over `listActiveSpaceIds()`, logging counts when they are
non-zero:

- **Seal** what is older than `chunkMaxAgeSeconds` (on the tick's own cadence).
- **Prune and sweep** hourly: `pruneSeries` for retention and the chunk cap,
  then `sweepOrphanedChunks`.

Deleting a space needs no new code: `deleteAll` already removes every prefix a
space stores under, chunks included, and `purgeExpiredSpaces` calls it.

## Clients

Points do not enter the replica cache. `ReplicaDb`'s stores mirror entity rows
a view reads by id; a time range of telemetry is neither, and caching it would
mean answering a range out of an IndexedDB store that holds an arbitrary subset
of it. Reads go through `api.series.*` on `ApiClient` and a
`useSeriesPoints(seriesId, range)` composable following `useDatabaseRows.ts` — a
query key plus a topic subscription that invalidates it. Series *definitions*
can become a replica store later, when a UI needs to list them offline.

## Config

In `#config`, beside the existing budgets:

- `VEKTOR_SERIES_CHUNK_POINTS` — points a chunk is sealed at; `5000` when unset.
- `VEKTOR_SERIES_CHUNK_MAX_AGE` — seconds before a short tail is sealed anyway;
  `3600` when unset.
- `VEKTOR_SERIES_MAX_BATCH` — points one append call may carry; `1000`.
- `VEKTOR_SERIES_MAX_CHUNKS` — the `maxChunks` a new series is declared with;
  `1000`.
- `VEKTOR_WORKFLOW_LOG_RETENTION_DAYS` — the window a run's log series is
  declared with; `30` when unset.

## Workflow run logs, on top of it

The first consumer, and the one that pays for the primitive. Today a run's log
lines live in `RunState.logs`, an in-memory array that `appendRunLog` pushes to
and `writeRunLogs` flushes to `artifacts/workflow/{runId}/logs.json` when the
run ends. Three things follow from that, and all three are why this moves:

- A process that dies mid-run takes the logs with it. `recoverSpace` marks the
  run failed and there is nothing to show for it — the lines that would say
  *why* it died are the ones that were never written.
- The array is the whole run's output, held in memory until it ends and then
  re-sent in full in every `GET workflows/runs/{runId}` response. Nothing
  bounds it: a chatty `exec` loop or a streaming agent grows it until the run
  finishes.
- One JSON blob cannot be paged, filtered by level, or tailed. `WorkflowView`
  reads `detail.logs` whole and slices the last three lines for its activity
  strip.

Note what it is *not*: a log line is already destined for one immutable object
in storage. The move is not from a table to storage, it is from a bespoke
one-object-per-run flush to the generic chunked one — which is why this consumer
is the proof that the primitive is the right shape.

### Shape

One series per run, declared in `createRun`'s existing transaction — beside the
`document` insert, not lazily on the first log line, so two concurrent appends
cannot both try to create it:

- `name`: `workflow-run:{runId}`
- `kind`: `log`
- `documentId`: the run document. Cascade cleans the series, its chunk rows and
  its tail up with the run, `clearRunStoreForTests` included, and ACL resolves
  correctly without a special case: document permission walks the `parent_id`
  chain (`getDocumentAncestorIds`), so the run document inherits the workflow
  document's grants — the same verdict the run route reaches today by checking
  `run.documentId` directly.
- `retentionDays` from config: the first bound run logs have ever had.
- `chunkPoints` lower than the default. A run's logs are read as a whole far
  more often than a GPS track is, and a finished short run should be one chunk.

A point per line: `ts` the line's own time, `data` `{ message }`, `label` the
level. `run.error` becomes a point with `label: "error"` rather than a field the
view concatenates onto the end of the array; it stays on the run document too,
since that is what the status badge reads.

### Writes are batched into the tail, not inserted per line

An insert per log line would put every line through SQLite's write lock at
whatever rate the script logs at. So `appendRunLog` keeps pushing to
`run.logs` — the array survives, its meaning narrows to *lines not yet
written* — and schedules a flush that drains it through `appendPoints` in one
statement, on the per-run promise chain `persistNow` already uses. Flush on a
line count or an elapsed interval, whichever comes first, and always from
`finalizeRun` and `cancelRun` before the run leaves `activeRuns`, which is also
where the run's final seal is requested. Reusing the existing chain is what
keeps two flushes for one run from interleaving; no new timer per run, and
nothing that can spin.

Liveness moves with it: `appendRunLog` stops emitting per line, and the flush
emits the `{ kind: "series" }` change once per batch. At a sub-second cadence
that is the same tailing experience for a fraction of the traffic.

### Reads

`readRunLogs` becomes a range query over the run's series — chunks for a
finished run, chunks plus tail for a live one, which the repository merges
either way. A run that predates this carries `_workflowRunLogArtifactPath` and
its lines are in a `logs.json` object, so the read is a branch on which of the
two the run document records — stored state, not a guess — and the artifact arm
is marked `@deprecated`, to be deleted once old runs have aged out. There is no
backfill: importing artifacts would mean reaching the storage adapter from
inside a SQL migration.

`GET workflows/runs/{runId}` keeps its `logs` field for a release, filled from
the series and marked `@deprecated` in `ApiClient`'s run detail type: it is in
the published OpenAPI schema, and `workflow.spec.ts` and `jobs.spec.ts` assert
on it, which makes it the parity harness for this change rather than something
to drop on the way past. The view moves to the points route through
`useSeriesPoints`, which also gets it paging and a level filter.

### What comes out

`writeRunLogs` and both its call sites in `workflowScript.ts`;
`runProperty.logArtifactPath` from `runProperties()`, so new runs stop writing
it; the `logs` array as a whole-run buffer; the `logArtifact` field in the run
response; and `WorkflowView`'s error-line concatenation.
`WorkflowArtifactKind` keeps `"logs"` (deprecated) only so old artifacts can
still be read back.

## Order of work

1. `chunks.ts` — format, compression, deterministic keys, the decode cache —
   with the round-trip test, before anything depends on it.
2. Schema and migration `3` (`createTables` plus the two `CREATE INDEX`
   statements; nothing to backfill), then the repository: append, seal, query,
   prune.
3. Routes, the `SpaceChange` variant, the route-access snapshot rows, and the
   config entries.
4. The tick's seal and the hourly prune and orphan sweep.
5. Workflow run logs, as above. After the sweeps, because a log series with no
   retention is the growth problem it is meant to fix.
6. `ApiClient` methods and the composable, then whatever view lands first — the
   run's log panel, or a track on a map.

## Integration test

`app/test/series.spec.ts`, at the level the repo tests at — route in, JSON out,
with the storage adapter behind it doing real writes:

- Declare a series, append batches whose timestamps interleave, and read the
  range back in order.
- Append past `chunkPoints`, seal, and assert the same range reads identically
  before and after — the invariant the whole design rests on, and the one thing
  a chunk bug would break. Assert the tail is empty and one object exists.
- Page a range query across a boundary that falls inside a chunk, and across
  one that falls between the last chunk and the tail.
- Seal twice over the same tail and assert one chunk object and one row, since
  the key is deterministic and the put is conditional.
- Assert a point for an undeclared series is refused, and that a viewer cannot
  append.
- Assert `pruneSeries` deletes the objects as well as the rows, and that
  `sweepOrphanedChunks` removes an object no row names while leaving a fresh
  one alone.

For the run logs, `workflow.spec.ts` and `jobs.spec.ts` already assert on
`run.logs` and keep asserting on it unchanged — that is the parity check. Two
cases go beyond what they cover: lines written before a simulated restart are
still readable afterwards (`resetRunStoreMemoryForTests` already simulates the
fresh process), and a run's series, chunks and objects are gone once its
document is deleted.

## Non-goals

- **No aggregation engine.** Bucketing a long range means decoding the chunks it
  covers and bucketing in JS; `series_chunk.count` and `bytes` are what let a
  read refuse a range too large to answer. Pre-computed rollup chunks are the
  natural next layer — a rollup is just another chunk with a coarser `dt` — and
  the index row already has room for the flag that would distinguish one.
- **No spatial indexing or bounding-box queries.** SQLite's R-tree is a
  compile-time module we cannot count on under libSQL, and the question a GPS
  view actually asks is "this series, this time range". A bounding box per chunk
  in the index row is where that would start.
- **No cross-space or cross-series reads.** A space is the boundary here as it
  is everywhere else.
- **No direct chunk URLs.** See the API section: an internal encoding with no
  per-point access control is not something to hand a client.
