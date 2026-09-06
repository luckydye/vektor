# Time-series data in a space

A place for points that carry their own time and are never edited: GPS tracks,
device telemetry, workflow and app logs. They are written by appending, read
back as a range, and forgotten by age rather than deleted by hand.

**Object storage is the source of truth.** Everything a series is — its
declaration, its points, and which of its objects are live — lives under one
prefix in the S3 or local-filesystem adapter behind `#files/storage.ts`. There
is no series table, no chunk index, no migration, and nothing in SQLite to keep
in step with the objects. Deleting the prefix deletes the series; the database
does not have an opinion about it.

## What that costs and what it buys

The database is very good at the thing being given up: an indexed range query.
So a read pays for it in listings and fetches instead — one `list` per time
window covered, then one `read` per object in it, with an in-process cache
because every object is immutable. In exchange:

- Nothing can drift. A chunk index in SQLite is a second copy of a fact that
  the storage layout already states, and every crash between the two writes is
  a reconciliation path to design, test and get wrong.
- Retention is a prefix delete, not a million row deletes plus object deletes.
- A space's purge already works: `deleteAll` removes every prefix a space stores
  under, and `purgeExpiredSpaces` calls it.
- The feature ships without a schema migration, and can be removed the same way.

The knob that makes the listing cost bearable is the **window** — points are
partitioned into fixed time windows, so a read lists only the windows it
overlaps, and a closed window's listing never changes again.

**This is the git subsystem's architecture, taken one step further.**
`#git/state.ts` and `#git/publish.ts` already keep immutable packs in storage,
coordinate a mutable manifest with `putConditional`, treat the local copy as a
cache that loses nothing when deleted, and sweep objects no manifest names.
Series need no manifest at all: the key names carry what the manifest would
have said.

## Layout

```
series/index/{name}.json                              the declaration
series/data/{name}/{window}/s-{arrival}-{uuid}.tsc.br a segment  (written by an append)
series/data/{name}/{window}/c-{watermark}.tsc.br      a chunk    (compacted from segments)
series/data/{name}/{window}/lease                     held while a window is compacting
```

- `{name}` is the series' handle, e.g. `gps:vehicle-7`. It is a key segment, so
  it is validated on declaration against a pattern like `GROUP_NAME_PATTERN` —
  `containedKey` would refuse a traversal anyway, but a name that cannot be a
  key should be rejected where it is chosen, not where it is used.
- `{window}` is the zero-padded start of a fixed-size time window (an hour by
  default, declared per series). Zero-padded because both adapters list
  lexically — `list` walks a prefix and sorts, S3 returns keys in order — so
  padding is what makes lexical order equal time order.
- `{arrival}` is when the server received the batch, not when the points
  happened. `{watermark}` is the greatest arrival a chunk has absorbed.

Declarations live under their own prefix because neither adapter's `list`
supports a delimiter: a listing returns every nested key, so putting
declarations beside the data would make "what series does this space have" a
scan of every chunk. Under `series/index/` it is one page of one listing.

Both prefixes stay out of the uploads listing and the file search index for the
reason `workflowArtifactKey` documents about artifacts — and `list()` without an
explicit prefix only walks the content-addressable uploads layout anyway.

## The three rules

This is the whole consistency story. It is precedence over key names and
self-describing objects, not two copies of a fact that have to agree.

**1. An append writes one new segment.** A unique key, so no conditional write,
no read-modify-write, and no lost update: concurrent appenders cannot collide.
A batch spanning two windows is split at the boundary, so every segment lies
inside exactly one window.

**2. A read of a window takes the chunk with the greatest watermark, plus every
segment that chunk does not name.** A chunk carries the list of segment keys it
absorbed, inside itself — it is fetched for its points anyway, so its header
costs nothing extra. Naming them explicitly, rather than inferring "everything
at or below my watermark", is what makes a segment that becomes visible late
safe: it is not in the set, so it is still read.

**3. Compaction is single-writer, and deletes only after the new chunk is
durable.** Take the window's `lease` with
`putConditional(…, { ifNoneMatch: true })` — the same conditional-write
coordination `#git/publish.ts` uses, and the interface's own documented use:
"losing a race is the expected way for a concurrent writer to find out it has to
re-read and try again". A lease older than its grace period, judged by `stat`'s
`updatedAt`, may be taken over; a crash therefore parks a window for minutes,
not forever. Then: read the current chunk and its live segments, write
`c-{watermark}` with `ifNoneMatch`, and only then delete the superseded chunk,
the segments it names, and the lease.

Everything a crash can leave behind reads correctly under rule 2: an abandoned
chunk with a lower watermark loses to the live one, and segments that were about
to be deleted are named by the winning chunk and skipped. The sweep collects
both later. Nothing is ever acknowledged to a writer and then lost, and no point
is ever read twice.

**Late points need no special case.** A point whose event time falls in a window
that was compacted long ago arrives with a *new* arrival stamp, becomes a
segment in that window, and reopens it for compaction. That is the reason
precedence is arrival-based rather than event-time-based.

## The chunk and segment format

Both are the same thing at different sizes: a time-ordered, columnar,
brotli-compressed JSON document.

```jsonc
{
  "v": 1,
  "name": "gps:vehicle-7",
  "window": 1764547200000,
  "count": 3600,
  "t0": 1764547200000,        // first event timestamp, absolute
  "dt": [0, 1000, 1000, 999], // deltas from the previous point
  "labels": [0, 0, 1, 0],     // dictionary indices, omitted when unlabelled
  "labelDict": ["info", "error"],
  "columns": {                // one array per field seen, nulls where absent
    "lat": [52.51, 52.51],
    "lon": [13.37, 13.37]
  },
  "subsumes": ["s-000…-a1b2"] // chunks only: the segments absorbed
}
```

Columnar because a chunk is decoded whole, because columns of like values are
what makes a compressor earn its keep, and because `JSON.parse` over a handful
of arrays is a different order of cost from parsing 50 000 small objects.
Columns are discovered from the points rather than declared per kind: a writer
that adds a field gets a new column, and older objects simply lack it.
Timestamps are deltas, so a steady sample rate compresses to nearly nothing.

Compression is async brotli on libuv's threadpool with the quality drop for
large payloads, copied from `compressRevisionContent` — `#db/space/revisions.ts`
carries the comment about what synchronous zlib did to Bun's event loop.

`v` is in the document because the format will change: a binary v2 with a footer
offset table, so `readStream`'s `ByteRange` can pull one column or one time
slice without fetching the object whole, is the obvious next step and needs
nothing else to change.

## The declaration

`series/index/{name}.json`, read whole and written with `putConditional` so two
concurrent edits cannot silently overwrite each other:

```jsonc
{
  "v": 1,
  "name": "gps:vehicle-7",
  "kind": "gps",              // picks the payload validator and the view
  "documentId": "doc_…",      // owning document, or null for a space-level series
  "windowSeconds": 3600,
  "retentionDays": 90,        // null keeps everything
  "compactAfterSegments": 20, // and/or once the window has closed
  "createdAt": "…",
  "createdBy": "user_…"
}
```

A point for a name with no declaration is refused. That is the cardinality
guard: without it a buggy extension mints unbounded stream names, and here that
means unbounded prefixes.

## Reads

`querySeriesPoints(spaceId, name, { from, to, label, limit, cursor })`:

1. Compute the windows `[from, to]` covers — arithmetic on `windowSeconds`, not
   a listing.
2. For each, `list` the window prefix, pick the chunk with the greatest
   watermark, and read it plus every segment it does not name.
3. Merge by event timestamp, filter, and page.

The cursor is the existing `encodeSeekCursor` with a string id — `{objectKey}:{offset}` — so a page boundary is exact wherever it falls, including
inside an object.

Caching is trivial and needs no invalidation, because every object is
immutable: an LRU of decoded objects keyed by storage key, capped by decoded
bytes, plus the listing of any window that has closed and been compacted. Only
the current window's listing has to be fresh. Dropping the whole cache loses
nothing — the same property `#git/cache.ts` calls "a cache in the strict sense".

`latestPointWithin(spaceId, name, maxWindows)` answers the live map pin and the
"last seen" label: walk back from the current window at most `maxWindows` and
return the newest point found. It is bounded on purpose and its name says so —
finding the last point of a series silent for a year would mean listing its
whole history, and "no point in the last N windows" is the honest answer for a
view showing where something is *now*.

## Writes

`appendPoints(spaceId, name, points)` — read the declaration, validate against
its kind, group the points by window, and write one segment per window. Bounded
by `SERIES_MAX_BATCH`. Nothing to lock, nothing to update.

`compactWindow(spaceId, name, window)` — rule 3 above.

`pruneSeries(spaceId, name, now)` — delete every key under the windows that
expired since the last prune. The expired windows are computed from the clock
and `retentionDays`, so pruning never lists a series' history; it lists and
deletes a bounded, known set of window prefixes.

`sweepSeries(spaceId, name)` — modelled on `sweepOrphanedPacks`: within a
window, delete chunks that lose to the winner and segments the winner names, and
leases past their grace period. Skips anything whose `updatedAt` is inside the
grace period, so an object being written right now is never mistaken for a leak.

## What still touches the database

Two reads of tables that already exist, and no writes:

- **ACL.** A series with a `documentId` is governed by that document:
  `verifyAccess(… ResourceType.DOCUMENT …)`, which walks the `parent_id` chain,
  so a child document inherits its parent's grants. Without one, the space's
  own role decides. Reads need `Permission.VIEWER`, writes `Permission.EDITOR`.
  No new `Feature` — nothing here is grantable independently of the role.
- **Ownership cleanup.** Deleting a document deletes the prefixes of the series
  that name it, in `deleteDocument`; the sweep is the backstop that catches a
  crash in between by dropping declarations whose document is gone. That is a
  one-directional check, not a mirrored row: storage asks the database a
  question, and never the other way round.

## Realtime

`SpaceChange` gains one variant in `#realtime/changes.ts`:

```ts
| { kind: "series"; name: string; documentId: string | null; latestTs: number; count: number }
```

mapped to `realtimeTopics.series(name)` and, when the series has one, the owning
document's topic. Emitted once per append rather than once per point, and it
carries counts, not data — clients refetch the range they are showing, as
everywhere else in the sync layer. Compaction emits nothing: it moves points
between two representations a read already merges.

## API

Registered in `#api/routes.ts`, documented by the JSDoc tags the OpenAPI
generator reads. The series is addressed by name, since that is what the layout
is keyed on and there is no id to look one up by:

| Route | Methods | Role |
| --- | --- | --- |
| `/api/v1/spaces/[spaceId]/series` | `GET`, `POST` | list / declare |
| `/api/v1/spaces/[spaceId]/series/[name]` | `GET`, `PATCH`, `DELETE` | read / retention / remove |
| `/api/v1/spaces/[spaceId]/series/[name]/points` | `POST` | append a batch |
| `/api/v1/spaces/[spaceId]/series/[name]/points` | `GET` | range query (`from`, `to`, `label`, `@paginated`) |

The append route authenticates through `authenticateJobTokenOrSpaceRole`, so a
workflow's job token and a device's space access token both reach it, and it
goes through the existing `apiRateLimiter`. Every new route needs its row in
`app/test/snapshots/route-access.md`, which snapshots the access matrix for
every registered route.

Chunks and segments are never served directly, and `redirectUrl` is never used
for them: they hold many points at once with no per-point access control, and a
read has to merge segments a client cannot be told to merge itself.

Workflow scripts need no new capability: `apiFetch` already reaches this
instance's API authenticated as the run.

## Sweeps

Two more due-checks in `cronScheduler.tick()`, beside `purgeExpiredSpacesIfDue`
and shaped like it — over `listActiveSpaceIds()`, logging counts when they are
non-zero:

- **Compact** windows that have closed, or that have more than
  `compactAfterSegments` segments (on the tick's own cadence).
- **Prune and sweep** hourly: expired windows first, then the garbage collector.

Discovering what to compact is one listing of `series/index/` per space plus one
per candidate window — bounded by the number of series, not by their history.

## Clients

Points do not enter the replica cache. `ReplicaDb`'s stores mirror entity rows a
view reads by id; a time range of telemetry is neither, and caching it would
mean answering a range out of an IndexedDB store that holds an arbitrary subset
of it. Reads go through `api.series.*` on `ApiClient` and a
`useSeriesPoints(name, range)` composable following `useDatabaseRows.ts` — a
query key plus a topic subscription that invalidates it.

## Config

In `#config`, beside the existing budgets:

- `VEKTOR_SERIES_WINDOW_SECONDS` — the window a new series is declared with;
  `3600` when unset.
- `VEKTOR_SERIES_MAX_BATCH` — points one append may carry; `1000`.
- `VEKTOR_SERIES_COMPACT_AFTER_SEGMENTS` — segments in a window before it is
  compacted early; `20`.
- `VEKTOR_SERIES_CACHE_BYTES` — decoded-object cache ceiling; `64` MiB.
- `VEKTOR_WORKFLOW_LOG_RETENTION_DAYS` — the window a run's log series is
  declared with; `30`.

## Workflow run logs, on top of it

The first consumer, and the one that pays for the primitive. Today a run's log
lines live in `RunState.logs`, an in-memory array that `appendRunLog` pushes to
and `writeRunLogs` flushes to `artifacts/workflow/{runId}/logs.json` when the
run ends. Three things follow from that, and all three are why this moves:

- A process that dies mid-run takes the logs with it. `recoverSpace` marks the
  run failed and there is nothing to show for it — the lines that would say
  *why* it died are the ones that were never written.
- The array is the whole run's output, held in memory until the run ends and
  then re-sent in full in every `GET workflows/runs/{runId}` response. Nothing
  bounds it: a chatty `exec` loop or a streaming agent grows it until the run
  finishes.
- One JSON object cannot be paged, filtered by level, or tailed. `WorkflowView`
  reads `detail.logs` whole and slices the last three lines for its activity
  strip.

Note what this is *not*: a log line is already destined for an immutable object
in storage. The move is from a bespoke one-object-per-run flush to the generic
segmented one — which is why this consumer is the proof that the primitive is
the right shape, and why it needs no new storage concept.

### Shape

One series per run, declared in `createRun` beside the run document:

- `name`: `workflow-run:{runId}`
- `kind`: `log`
- `documentId`: the run document, so ACL resolves through the `parent_id` walk
  to the workflow document's grants — the same verdict the run route reaches
  today by checking `run.documentId` — and so deleting the run deletes the
  series, `clearRunStoreForTests` included.
- `windowSeconds` short, and `compactAfterSegments` low: a run is minutes, and
  a finished one should settle into a single chunk that reads in one fetch.
- `retentionDays` from config: the first bound run logs have ever had.

A point per line: the line's own time, `{ message }`, and the level as its
label. `run.error` becomes a point labelled `error` rather than a field the view
concatenates onto the end of the array; it stays on the run document too, since
that is what the status badge reads.

### Writes are batched into segments

A segment per log line would be an object per line. So `appendRunLog` keeps
pushing to `run.logs` — the array survives, its meaning narrows to *lines not
yet written* — and schedules a flush that writes one segment per batch, on the
per-run promise chain `persistNow` already uses. Flush on a line count or an
elapsed interval, whichever comes first, and always from `finalizeRun` and
`cancelRun` before the run leaves `activeRuns`, which is also where the run's
final compaction is requested. Reusing the existing chain is what keeps two
flushes for one run from interleaving; no new timer per run, and nothing that
can spin.

Liveness moves with it: `appendRunLog` stops emitting per line, and the flush
emits the `{ kind: "series" }` change once per batch. At a sub-second cadence
that is the same tailing experience for a fraction of the traffic.

The flush interval is the durability window, and it is the one thing this
consumer trades for not writing an object per line: a crash loses at most the
last interval's lines, where today it loses all of them.

### Reads

`readRunLogs` becomes a range query over the run's series. A run that predates
this carries `_workflowRunLogArtifactPath` and its lines are in a `logs.json`
object, so the read is a branch on which of the two the run document records —
stored state, not a guess — and the artifact arm is marked `@deprecated`, to be
deleted once old runs have aged out. There is no backfill.

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

1. `app/src/series/format.ts` — encode, decode, deterministic keys — with its
   round-trip test, before anything depends on it.
2. `app/src/series/store.ts` — declarations, append, read, the decoded-object
   cache. No compaction yet: rule 2 reads a window of pure segments correctly,
   which is what makes it safe to land first.
3. Compaction, prune and sweep, then their due-checks on the tick.
4. Routes, the `SpaceChange` variant, the route-access snapshot rows, and the
   config entries.
5. Workflow run logs, as above.
6. `ApiClient` methods and the composable, then whatever view lands first — the
   run's log panel, or a track on a map.

No migration at any step. Nothing here touches `#db/schema/space.ts`.

## Integration test

`app/test/series.spec.ts`, at the level the repo tests at — route in, JSON out,
with a real storage adapter behind it. The invariant every case exists to
protect is that **a range reads identically whatever state its objects are in**:

- Declare a series, append batches whose timestamps interleave, read the range
  back in order.
- Read a range, compact it, read it again: identical. Then assert one chunk and
  no segments remain.
- Append a *late* point into an already-compacted window and read the range
  again: it appears, and the window compacts a second time without losing it.
- Simulate the crash windows directly, since they are the design's real risk:
  a chunk written but nothing deleted (extra chunk, undeleted segments) reads
  identically, and the sweep then removes exactly the garbage; a held lease
  blocks compaction until its grace period passes.
- Page a range across a boundary inside one object and across two objects.
- Assert a point for an undeclared series is refused, and that a viewer cannot
  append.
- Assert prune deletes the expired windows and leaves the live ones, and that
  deleting the owning document takes the whole prefix with it.

For the run logs, `workflow.spec.ts` and `jobs.spec.ts` already assert on
`run.logs` and keep asserting on it unchanged — that is the parity check. Two
cases go beyond them: lines flushed before a simulated restart are still
readable afterwards (`resetRunStoreMemoryForTests` already simulates the fresh
process), and a run's objects are gone once its document is deleted.

## Non-goals

- **No aggregation engine.** Bucketing a long range means decoding the objects
  it covers and bucketing in JS; a chunk's `count` is what lets a read refuse a
  range too large to answer. Pre-computed rollups are the natural next layer — a
  rollup is just another chunk with a coarser `dt`, under a `r-` key beside the
  `c-` one.
- **No spatial queries.** The question a GPS view asks is "this series, this
  time range". A bounding box in a chunk's header is where that would start.
- **No cross-space or cross-series reads.** A space is the boundary here as it
  is everywhere else.
- **No direct object URLs.** See the API section.
- **No unbounded "latest point".** See `latestPointWithin`.
