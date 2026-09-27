# Time-series data in a space

**A time-series store backed by our object storage.** Points (GPS, telemetry,
logs) are appended, read as a time range, and expire by age. They live only as
immutable objects in the adapter behind `#files/storage.ts`; key names replace an
index.

> The database may hold what a series **is**, never what it **contains**.

SQLite holds the declaration, the compaction claim and a dirty-window queue — no
point rows, no chunk index. Same idea as `#git/` packs, minus the manifest.

On top sits one in-process event bus: every successful append is published, and
subscribers filter with the same predicates stored queries use.

## Layout

```
series/{id}/{window}/s-{arrival}-{uuid}.tsc.br  segment (one per append per window)
series/{id}/{window}/c-{watermark}.tsc.br       chunk   (compacted segments)
```

- `{id}`: UUID, never reused; the name (`gps:vehicle-7`) appears only in URLs.
- `{window}`: zero-padded start of a fixed window (default 1 h) → lexical = time order.
- `{arrival}`: server receive time; `{watermark}`: greatest arrival absorbed.

## Consistency rules

1. **Append = one new segment per window**, unique key, no locks. Batches spanning
   windows are split.
2. **Read a window = newest chunk + every segment it doesn't name.** Chunks list
   absorbed segments in their header, cumulatively.
3. **Compaction is single-writer and never deletes inline.** Claim via
   compare-and-swap on `series.compacting_at` with a TTL (like
   `claimMigrationLock`); write `c-{watermark}` with `ifNoneMatch`.

- **Deadlines:** writes abort past `SERIES_WRITE_DEADLINE_MS` (< claim TTL), reads
  past `SERIES_READ_DEADLINE_MS`. Superseded objects are deleted
  `SERIES_SUPERSEDED_GRACE_MS` after the new chunk's `compactedAt`, which exceeds
  the read deadline — so listed objects never vanish mid-read (a 404 throws).
- **Order:** event time → source segment → index. Stable across compactions.
- **Late points** become a new segment in the old window and mark it dirty.
- **Bounds:** a batch is refused whole if any point is older than retention or
  newer than `now + SERIES_MAX_FUTURE_SECONDS`.

Every crash leftover reads correctly under rule 2.

## Object format

`{8-digit header length}{JSON header}{brotli columnar body}`. A 16 KiB range read
gets the header without the body.

```jsonc
// header
{ "v": 1, "series": "5f0c…", "name": "gps:vehicle-7", "window": 1764547200000,
  "count": 3600, "from": 1764547200000, "to": 1764550799000,
  "columns": {
    "speed":   { "type": "number", "min": 0, "max": 31.4, "nulls": 0 },
    "level":   { "type": "string", "nulls": 0, "values": ["info", "error"] },
    "traceId": { "type": "string", "nulls": 0, "bloom": "…" },
    "message": { "type": "string", "nulls": 0 } },
  "subsumes": ["s-…"], "compactedAt": 1764551000000 }   // chunks only
// body
{ "t0": 1764547200000, "dt": [0, 1000, 999],
  "segments": ["…"], "src": [0, 0, 1], "idx": [0, 1, 0], // chunks only
  "columns": { "speed": [0, 4.2, 11.9], "level": [0, 0, 1], "message": ["…"] } }
```

- Columns are discovered from points.
- Strings: ≤ `SERIES_MAX_COLUMN_VALUES` distinct → exact `values` set +
  dictionary encoding; more → bloom filter. Stats are computed from encoded
  points, never supplied.
- Async brotli, as `compressRevisionContent`.

## Tables (migration `6`)

- `series`: `id`, `name` (unique), `kind` (`gps|log|metric`), `documentId`
  (cascade), `windowSeconds` (immutable), `retentionDays`,
  `compactAfterSegments`, `compactingAt` (claim), `oldestWindow` (where prune
  starts), `pointCount`/`byteCount` (cosmetic), `createdAt`, `updatedAt`,
  `createdBy`.
- `series_dirty_window(seriesId, window, segments)`: append writes the segment,
  then increments; compaction subtracts the count it read before listing and
  deletes the row at zero.

A name with no row is refused (cardinality guard). Deleting a series or its
document removes the row, then lists and deletes `series/{id}/`. Nothing deletes
objects because a row is missing.

## Module boundary

- `#series/` (storage engine) imports only storage, its tables, `#config`, logger.
  No ACL, realtime, jobs or events.
- `#events/` (`ingestPoints` + bus) is the sole importer of `appendPoints`.
- Access control lives in routes only.
- An importer-inventory spec (like `egress-call-sites.spec.ts`) enforces this.

## Event stream

```ts
export interface SpaceEvent {
  ts: number; series: string; type: string; documentId: string | null;
  fields: Record<string, number | string | boolean | null>;
}
export async function ingestPoints(store, name, points): Promise<{ latestTs: number; count: number }>;
export function subscribeToEvents(spaceId, filter: SeriesPredicate[], onEvents): () => void;
```

- Publish happens **after** the append is durable; no replay.
- A `Set` of listeners with a bounded buffer per subscriber; overflow unsubscribes.
- Subscribers are read-only.

## Reads and queries

`readSeriesPoints(store, name, { from, to, where, limit, cursor })`: compute
windows, list + fetch concurrently, merge, filter, page. Cursor names a point
(`{arrival}-{uuid}:{index}`), so it survives compaction. Decoded objects are
cached (LRU by bytes); listings have a short TTL. `latestPointWithin(store,
name, maxWindows)` is a bounded "last seen".

```ts
export interface SeriesQuery {
  from: number; to: number; where?: SeriesPredicate[];
  every?: number; groupBy?: { column: string }; select: SeriesAggregate[];
}
export type SeriesPredicate =
  | { column: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; value: number | string }
  | { column: string; op: "in"; value: Array<number | string> }
  | { column: string; op: "contains"; value: string }
  | { column: string; op: "exists" };
export type SeriesAggregate =
  | { fn: "count" } | { fn: "sum" | "avg" | "min" | "max" | "first" | "last"; column: string };
```

Planner: list → read headers → prune by range/min/max/values/bloom → refuse if
surviving `count` > `SERIES_MAX_SCAN_POINTS` → decode named columns and bucket.
Response includes `scanned` (`objects`, `prunedObjects`, `points`, `source`,
`prunedBy`, `scannedFor`). Only mergeable aggregates, so rollups
(`r{every}-{watermark}.tsc.br`) can be added later without API changes.

## Maintenance

Beside `purgeExpiredSpacesIfDue` in `cronScheduler.tick()`:
- **Compact** dirty windows that closed or reached `compactAfterSegments`, then
  schedule collection of superseded objects.
- **Prune** hourly from `oldestWindow` to the retention horizon (minus
  `SERIES_SETTLE_MS`), and skip series `PATCH`ed within that margin.

## Realtime and API

`ingestPoints` publishes `{ kind: "series"; name; documentId; latestTs; count }`
to `series(name)` (document ACL) and `space:events` (space role only).
Notifications only; clients refetch.

| Route | Methods |
| --- | --- |
| `/api/v1/spaces/[spaceId]/series` | `GET`, `POST` (idempotent declare) |
| `…/series/[name]` | `GET`, `PATCH` (not `windowSeconds`), `DELETE` |
| `…/series/[name]/points` | `POST` append, `GET` range (`@paginated`) |
| `…/series/[name]/query` | `POST` `SeriesQuery` |

Read = `VIEWER`, write = `EDITOR`, on the owning document or the space. Auth
through `authenticateJobTokenOrSpaceRole` + `apiRateLimiter`, with rows in
`route-access.md`. Objects are never served directly.

Client: `api.series.*`, `useSeriesPoints`, `useSeriesQuery` (filter in query
key, topic invalidation). Points stay out of `ReplicaDb`.

## Config

`VEKTOR_SERIES_WINDOW_SECONDS` 3600, `_MAX_BATCH` 1000,
`_COMPACT_AFTER_SEGMENTS` 20, `_MAX_FUTURE_SECONDS` 300, `_CACHE_BYTES` 64 MiB,
`_MAX_SCAN_POINTS` 5M, `_MAX_BUCKETS` 10k, `_MAX_GROUPS` 1k,
`_MAX_COLUMN_VALUES` 256; `VEKTOR_EVENTS_SUBSCRIBER_QUEUE` 10k;
`VEKTOR_WORKFLOW_LOG_FLUSH_MS` 1000, `_FLUSH_LINES` 500, `_RETENTION_DAYS` 30.

Timing constants in `#series/`, with their ordering asserted at load: write
deadline 30 s, settle 60 s, read deadline 60 s, superseded grace 300 s, claim
TTL > write deadline.

## First consumer: workflow run logs

Replaces `RunState.logs` + `writeRunLogs` → `logs.json`, which loses everything
on a crash and is unbounded.

- Series `workflow-run:{runId}`, `kind: log`, owned by the run document.
- One event per line: `type: workflow.log`, `level`, `message`, `runId`.
- `runStore` posts batches to the append route via loopback with its job token
  (flushed by count/interval on the `persistNow` chain and on finalize/cancel).
- The run response drops `logs` (breaking), and `WorkflowView` uses
  `useSeriesPoints`.
- Old runs are read via a `@deprecated` `logs.json` path. No backfill.

## Order of work

1. `series/format.ts` 2. tables 3. `store.ts` (append/read)
4. compaction, prune, deletion, cron 5. `query.ts` 6. `events/`
7. routes, realtime, config, inventory spec 8. run logs
9. client + first view 10. rollups

## Tests

Integration, real storage. Core invariant: **a range reads identically whatever
state its objects are in** — before and after compaction, with late points,
crash leftovers, concurrent readers, and paging across a compaction. Also cover:

- live bus filter = stored `where` result;
- pruning on vs off gives identical query rows;
- scan limit refuses before reading bodies;
- retention and deletion;
- ACL on routes and topics;
- run logs survive a restart.

## Non-goals

Exact quantiles, joins/expressions, spatial queries, cross-series stored
queries, bus replay, writers on the bus, direct object URLs, unbounded latest
point, recovery from a lost DB / orphan sweep.
