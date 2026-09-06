# Time-series data in a space database

A place for points that carry their own time and are never edited: GPS tracks,
device telemetry, workflow and app logs. They are written by appending, read
back as a range, and forgotten by age rather than deleted by hand.

## What exists already, and why none of it is the place

- **`audit_log`** is the right shape — autoincrement id, a `(ts DESC, id DESC)`
  index, seek cursors — and the wrong scope: `doc_id` is `NOT NULL`, `event` is
  a closed union in `#db/space/auditLogs.ts`, and nothing ever removes a row.
  Its query and cursor code is the template the new repository copies, not the
  table the points go in.
- **A `database` document with `record` children** already stores structured
  rows. One point through that path costs a `document` row, a `property` row per
  field, a `change_seq` allocation (the space's single write counter, taken
  under SQLite's write lock), a document-tree broadcast, and a search-index
  entry. That is right for a few hundred hand-entered rows and unusable at 1 Hz.
- **Workflow run logs** are held in an in-memory array during the run and
  flushed to a file artifact at the end (`#jobs/runStore.ts`,
  `#jobs/workflowArtifacts.ts`). They cannot be queried, cannot be tailed, and
  are lost if the process restarts mid-run. This is the first consumer to move,
  and the reason to build this at all.
- **A sidecar database per space** would keep telemetry out of the documents
  file, but hosted mode registers exactly one libSQL database per space in
  `space_index` and has no second location to provision. Series live in the
  space database; volume is a retention problem, not a file-layout problem.

## Schema

Two tables in `#db/schema/space.ts`, created by migration `3`.

```ts
export const series = sqliteTable(
  "series",
  {
    id: text("id").primaryKey(),
    /** The stable handle a writer addresses, e.g. "gps:vehicle-7". */
    name: text("name").notNull(),
    /** Payload shape: "gps" | "log" | "metric". Picks the validator and the view. */
    kind: text("kind").notNull(),
    /** Owning document; the series and its points go with it. Null = space-level. */
    documentId: text("document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    /** Retention window in days. Null keeps points until the count cap evicts them. */
    retentionDays: integer("retention_days"),
    /** Ceiling on rows; the sweep drops the oldest above it. */
    maxPoints: integer("max_points").notNull().default(100_000),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("series_name_unique").on(t.name)],
);

export const seriesPoint = sqliteTable("series_point", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seriesId: text("series_id")
    .notNull()
    .references(() => series.id, { onDelete: "cascade" }),
  /** The event's own time, from the writer — not when the server received it. */
  ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  /** One low-cardinality tag: a log level, an event name. Null when the kind has none. */
  label: text("label"),
  /** The point itself, as JSON: `{lat, lon, alt}` for gps, `{message, …}` for log. */
  data: text("data").notNull(),
});
```

The read index is written as raw SQL in the migration, the way the baseline
writes `audit_log`'s, so its direction matches the query's:

```sql
CREATE INDEX IF NOT EXISTS series_point_series_ts_idx
  ON series_point (series_id, ts DESC, id DESC)
```

Decisions worth recording, so they are not reopened by accident:

- **`timestamp_ms`, not `timestamp`.** Every other table stores seconds; a
  position at 1 Hz and two log lines in the same second need milliseconds.
  `schemaUtils.getSQLiteType` already maps it to `INTEGER` affinity.
- **No `value REAL` column.** A metric's number lives in `data` and is read with
  `json_extract`, which keeps one payload column and one write path instead of
  two nullable columns and a branch on which is populated. Add the column (plus
  an expression index) only if aggregation over a series past a million points
  shows up in a profile.
- **A declaration table, not just points.** Retention and the cap need somewhere
  to live, listing a space's series must not be a `SELECT DISTINCT` over the
  points, and a point naming an undeclared series is refused — which is what
  stops a buggy extension from minting unbounded stream names.
- **`name` is unique per space**, with an optional `documentId` for ownership.
  A series that belongs to a document is deleted with it by the cascade; a
  space-level series (a fleet's positions, the instance's own logs) has no
  document to hang from.

## Repository: `app/src/db/space/series.ts`

Takes a `SpaceStore` like every other repository, returns rows, knows nothing
about routes.

- `createSeries`, `getSeriesByName`, `getSeries`, `listSeries(store, { documentId })`,
  `updateSeriesRetention`, `deleteSeries`.
- `appendPoints(store, seriesId, points)` — one transaction, one multi-row
  insert, bounded by `SERIES_MAX_BATCH`. Throws when the series is unknown;
  there is no implicit create, because that is the cardinality guard.
- `querySeriesPoints(store, seriesId, { from, to, label, limit, cursor })` —
  keyset pagination on `(ts, id)` through the existing `encodeSeekCursor` /
  `decodeSeekCursor(cursor, "number")`, identical to `getAuditLogsForDocument`.
- `bucketSeriesPoints(store, seriesId, { from, to, bucketMs })` — one row per
  bucket, `GROUP BY ts / bucketMs` taking `MIN(id)` per bucket, so a twelve-hour
  track renders without shipping every point. Bucketing in SQL, not in the view.
- `latestPoint(store, seriesId)` — the map pin and the "last seen" label; one
  indexed row.
- `pruneSeries(store, now)` — `DELETE FROM series_point WHERE series_id = ? AND
  ts < ?` for the window, then the cap via `id <= (SELECT id … ORDER BY id DESC
  LIMIT 1 OFFSET max_points)`. Returns what it deleted per series. The only
  place points are removed by policy.

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
holds the event until the commit lands.

## API

Registered in `#api/routes.ts`, documented by the JSDoc tags the OpenAPI
generator reads:

| Route | Methods | Role |
| --- | --- | --- |
| `/api/v1/spaces/[spaceId]/series` | `GET`, `POST` | list / declare |
| `/api/v1/spaces/[spaceId]/series/[seriesId]` | `GET`, `PATCH`, `DELETE` | read / retention / remove |
| `/api/v1/spaces/[spaceId]/series/[seriesId]/points` | `POST` | append a batch |
| `/api/v1/spaces/[spaceId]/series/[seriesId]/points` | `GET` | range query (`from`, `to`, `label`, `bucketMs`, `@paginated`) |

Access follows what the series is attached to: with a `documentId`, the verdict
is that document's through `verifyAccess(… ResourceType.DOCUMENT …)`; without
one, the space's. Reads need `Permission.VIEWER`, writes `Permission.EDITOR`.
No new `Feature` — nothing here is grantable independently of the role.

The append route authenticates through `authenticateJobTokenOrSpaceRole`, so a
workflow's job token and a device's space access token both reach it, and it
goes through the existing `apiRateLimiter`. Every new route needs its row in
`app/test/snapshots/route-access.md`, which snapshots the access matrix for
every registered route.

Workflow scripts need no new capability: `apiFetch` already reaches this
instance's API authenticated as the run.

## Retention sweep

One more due-check in `cronScheduler.tick()`, beside `purgeExpiredSpacesIfDue`
and shaped like it: hourly, over `listActiveSpaceIds()`, calling `pruneSeries`
per space and logging the count when it is non-zero. Nothing else deletes
points on a schedule, and the write path does no counting.

## Clients

Points do not enter the replica cache. `ReplicaDb`'s stores mirror entity rows
a view reads by id; a time range of telemetry is neither, and caching it would
mean answering a range out of an IndexedDB store that holds an arbitrary subset
of it. Reads go through `api.series.*` on `ApiClient` and a
`useSeriesPoints(seriesId, range)` composable following `useDatabaseRows.ts` — a
query key plus a topic subscription that invalidates it. Series *definitions*
can become a replica store later, when a UI needs to list them offline.

## Config

Two entries in `#config`, beside the existing budgets:

- `VEKTOR_SERIES_MAX_POINTS_PER_SERIES` — the `maxPoints` a new series is
  declared with; `100000` when unset.
- `VEKTOR_SERIES_MAX_BATCH` — points one append call may carry; `1000` when
  unset.
- `VEKTOR_WORKFLOW_LOG_RETENTION_DAYS` — the window a run's log series is
  declared with; `30` when unset.

## Workflow run logs, on top of it

The first consumer, and the one that pays for the primitive. Today a run's log
lines live in `RunState.logs`, an in-memory array that `appendRunLog` pushes to
and `writeRunLogs` flushes to `artifacts/workflow/{runId}/logs.json` through the
storage adapter when the run ends. Three things follow from that, and all three
are why this moves:

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

### Shape

One series per run, declared in `createRun`'s existing transaction — beside the
`document` insert, not lazily on the first log line, so two concurrent appends
cannot both try to create it:

- `name`: `workflow-run:{runId}`
- `kind`: `log`
- `documentId`: the run document. Cascade cleans the series and its points up
  with the run, `clearRunStoreForTests` included, and ACL resolves correctly
  without a special case: document permission walks the `parent_id` chain
  (`getDocumentAncestorIds`), so the run document inherits the workflow
  document's grants — the same verdict the run route reaches today by checking
  `run.documentId` directly.
- `retentionDays` / `maxPoints`: from config, and the first bound run logs have
  ever had.

A point per line: `ts` the line's own time, `data` `{ message }`, `label` the
level. Log lines are what the `(ts, id)` cursor tiebreaker exists for — several
lines land in the same millisecond routinely, and `ts` alone cannot order them.

`run.error` becomes a point with `label: "error"` rather than a field the view
concatenates onto the end of the array. It stays on the run document too, since
that is what the status badge reads.

### Writes are batched, not per line

An insert per log line would put every line through SQLite's write lock at
whatever rate the script logs at. So `appendRunLog` keeps pushing to
`run.logs` — the array survives, its meaning narrows to *lines not yet
written* — and schedules a flush that drains it through `appendPoints` in one
statement, on the per-run promise chain `persistNow` already uses. Flush on a
line count or an elapsed interval, whichever comes first, and always from
`finalizeRun` and `cancelRun` before the run leaves `activeRuns`. Reusing the
existing chain is what keeps two flushes for one run from interleaving; no new
timer per run, and nothing that can spin.

Liveness moves with it: `appendRunLog` stops emitting per line, and the flush
emits the `{ kind: "series" }` change once per batch. At a sub-second cadence
that is the same tailing experience for a fraction of the traffic.

### Reads

`readRunLogs` becomes a range query over the run's series. A run that predates
this carries `_workflowRunLogArtifactPath` and its lines are in storage, so the
read is a branch on which of the two the run document records — stored state,
not a guess — and the artifact arm is marked `@deprecated`, to be deleted once
old runs have aged out. There is no backfill: importing artifacts would mean
reaching the storage adapter from inside a SQL migration.

`GET workflows/runs/{runId}` keeps its `logs` field for a release, filled from
the series and marked `@deprecated` in `ApiClient`'s `WorkflowRunDetail`: it is
in the published OpenAPI schema, and `workflow.spec.ts` and `jobs.spec.ts`
assert on it, which makes it the parity harness for this change rather than
something to drop on the way past. The view moves to the points route through
`useSeriesPoints`, which also gets it paging and a level filter.

### What comes out

`writeRunLogs` and both its call sites in `workflowScript.ts`;
`runProperty.logArtifactPath` from `runProperties()`, so new runs stop writing
it; the `logs` array as a whole-run buffer; the `logArtifact` field in the run
response; and `WorkflowView`'s error-line concatenation.
`WorkflowArtifactKind` keeps `"logs"` (deprecated) only so old artifacts can
still be read back.

## Order of work

1. Schema, migration `3` (`createTables` plus the two `CREATE INDEX`
   statements — nothing to backfill), and the repository.
2. Routes, the `SpaceChange` variant, the route-access snapshot rows, and the
   config entries.
3. The retention sweep.
4. Workflow run logs, as above. It lands after the sweep because a log series
   without retention is the growth problem it is meant to fix.
5. `ApiClient` methods and the composable, then whatever view lands first — the
   run's log panel, or a track on a map.

## Integration test

`app/test/series.spec.ts`, at the level the repo tests at — route in, JSON out:
declare a series, append two batches whose timestamps interleave, page a range
query across a cursor boundary, read the same range bucketed, assert a point for
an undeclared series is refused, assert a viewer cannot append, and assert the
sweep drops points past the window and above the cap.

For the run logs, `workflow.spec.ts` and `jobs.spec.ts` already assert on
`run.logs` and keep asserting on it unchanged — that is the parity check. Two
cases go beyond what they cover: lines written before a simulated restart are
still readable afterwards (`resetRunStoreMemoryForTests` already simulates the
fresh process), and a run's series and points are gone once its document is
deleted.

## Non-goals

- No spatial indexing or bounding-box queries. SQLite's R-tree is a
  compile-time module we cannot count on under libSQL, and the question a GPS
  view actually asks is "this series, this time range".
- No aggregation beyond time bucketing. `avg`/`min`/`max` per bucket can be
  added to `bucketSeriesPoints` when a view needs them; a query language cannot.
- No cross-space or cross-series reads. A space database is the boundary here as
  it is everywhere else.
