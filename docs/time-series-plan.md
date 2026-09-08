# Time-series data in a space

A place for points that carry their own time and are never edited: GPS tracks,
device telemetry, workflow and app logs. They are written by appending, read
back as a range, and forgotten by age rather than deleted by hand.

**Two layers, and keeping them apart is the design: one event stream in front,
many series behind it.** Everything a space records is published to a single
in-process bus as an *event*, and anything that wants some of it subscribes with
a filter. One of those subscribers is the storage sink, which routes each event
into the series it belongs to. So the stream is unified and the storage is not,
and neither has to compromise for the other: a view can watch every kind of
event at once, and a series still gets its own prefix, its own retention and its
own compactor.

Most of this document is about the storage half, because that is where the hard
consistency problems are. The stream is one section, and it is deliberately
small — a bus that grows features is a bus that has started making product
decisions.

**Object storage is the source of truth for the points.** Every point a series
holds lives under one prefix in the S3 or local-filesystem adapter behind
`#files/storage.ts`, in immutable objects whose key names carry what an index
would otherwise have said. There is no chunk index and no point rows.

One table describes what series exist. The line it draws:

> The database may hold what a series **is**. It may never hold what a series
> **contains**.

What a series *is* — its name, kind, owning document, retention, window size,
and the claim a compactor holds while it works — is small, mutable, relational,
and stored nowhere else, so there is no second copy to drift from. What it
*contains* is bulk, immutable and append-only, and stays in storage as its only
copy.

Being precise about the one dependency that remains: a read consults the row for
two facts, the window size it needs to know which prefixes to look under and the
document it must check access against. Neither is a point, and the first is also
stamped into every object's header — so a lost table costs declarations and
policy, never data, and a recovery command can rebuild it by walking the
prefixes. The test at the end of this document does exactly that.

## What that costs and what it buys

The database is very good at the thing being given up: an indexed range query.
So a read pays for it in listings and fetches instead — one `list` per time
window covered, then one `read` per object in it, both issued concurrently
across windows, with an in-process cache because every object is immutable. In
exchange:

- Nothing can drift. A chunk index in SQLite is a second copy of a fact that
  the storage layout already states, and every crash between the two writes is
  a reconciliation path to design, test and get wrong.
- Retention is a prefix delete, not a million row deletes plus object deletes.
- A space's purge already works: `deleteAll` removes every prefix a space stores
  under, and `purgeExpiredSpaces` calls it.

A note on an optimisation that looks free and is not: naming a compacted
window's chunk deterministically (`{window}/c.tsc.br`) would let a read fetch it
at a known key with no listing at all. It cannot be had, because re-compacting
that window then *overwrites* the object — which forfeits the immutability the
decoded-object cache depends on, and opens a window in which a reader holding
the old chunk goes looking for segments the new one has already absorbed. Unique
chunk keys and one concurrent listing per window are the cheaper trade.

The knob that makes the listing cost bearable is the **window** — points are
partitioned into fixed time windows, so a read lists only the windows it
overlaps, and a window that has been compacted is one object plus, in the
ordinary case, nothing else.

**This is the git subsystem's architecture, taken one step further.**
`#git/state.ts` and `#git/publish.ts` already keep immutable packs in storage,
coordinate a mutable manifest with `putConditional`, treat the local copy as a
cache that loses nothing when deleted, and sweep objects no manifest names.
Series need no manifest at all: the key names carry what the manifest would
have said.

## The event stream

A GPS fix, a workflow log line and a device reading are all the same thing on
the way in — an event — and they only become different things when the sink
decides which series each belongs to. `app/src/events/bus.ts` is that middle,
and it is about a hundred lines:

```ts
export interface SpaceEvent {
  /** Event time, not arrival: this becomes the point's timestamp. */
  ts: number;
  /** Which series stores it. Derived at ingest, never free-form; see below. */
  series: string;
  /** What it is, e.g. "workflow.log", "gps.fix", "device.telemetry". */
  type: string;
  /** The series' owning document, so a subscriber can be scoped to it. */
  documentId: string | null;
  /** The payload. Becomes the point's columns verbatim. */
  fields: Record<string, number | string | boolean | null>;
}

export function publishEvents(spaceId: string, events: SpaceEvent[]): void;

export function subscribeToEvents(
  spaceId: string,
  filter: SeriesPredicate[],
  onEvents: (events: SpaceEvent[]) => void,
): () => void;
```

`type` is a column like any other, so it is filterable, groupable and prunable
by the same machinery as `speed` — there is no privileged dimension. A firehose
is `subscribeToEvents(spaceId, [], …)`; every narrower use case is the same call
with predicates.

Four decisions, and they are the whole design:

**The filter is `SeriesPredicate[]` — the same type the stored query uses.** A
log panel tailing `type = "workflow.log"` and `level = "error"` and that same
panel paging backwards through storage hand the *identical* object to two
different executors, over one predicate evaluator. This is the reason to have a
bus at all rather than a websocket topic per producer: a filter that means one
thing live and another thing at rest is a bug that only appears at the seam, and
this way there is no seam. It is also why the predicate type is defined in
`#series/query.ts` and imported by the bus, not the other way round — the harder
executor owns the vocabulary.

**`series` is derived at ingest, never taken from the caller.** The route maps a
`type` and its subject to a name (`workflow.log` for run `r7` is
`workflow-run:r7`), and a name with no row is refused as it is today. That is
where the cardinality guard lives now: without it a buggy producer mints
unbounded series names, and here that means unbounded prefixes. A producer
chooses what it is saying, not where it is stored.

**The bus is in-process, and it is not durable.** It is the same shape as
`#realtime/events.ts` — a `Set` of listeners, fanned out synchronously — for the
same reason: the durable copy is somewhere else, so losing this costs a resync
and never a fact. An event is acknowledged to its writer when the **sink has
appended it**, not when it reached the bus, which is what keeps "the stream is
lossy" from ever meaning "a point was lost". A subscriber that cannot keep up is
dropped rather than allowed to block ingest, and it says so in the log.

**Nothing subscribes in order to write to a second place.** The sink is the only
subscriber that persists anything. Everything else — realtime fan-out, and
whatever monitoring wants next — is read-only on the stream. Two writers on one
bus is how a bus turns into an orchestrator that has to guarantee ordering
between them, and that is a much larger design than this one.

### The sink

`app/src/events/sink.ts` is the only thing that turns events into points. It
subscribes with an empty filter, groups a flush by series, and calls
`appendPoints` once per series — so a batch spanning three series is three
appends and a batch spanning one is one, which is the batching the storage layer
already wants. It flushes on a point count or an elapsed interval, whichever
comes first.

The sink is where two facts that were previously spread across every producer
now live exactly once: the flush interval is the durability window for
*everything*, and the append is the acknowledgement. A producer that needs a
stronger guarantee than "at most one interval" calls the append route directly
and takes the round trip; nothing does today.

### What this replaces

The earlier draft of this document had each producer call the append route and
then emit its own `SpaceChange`. That works, and it means every new kind of
event is a new producer teaching itself the same two steps, with a second
implementation of "which of these lines does this view want" on the client. With
the bus there is one filter language, one place a filter is evaluated, and one
answer to what happened in this space in the last minute.

What it does **not** replace is the storage layout. Series stay separate: their
own prefix, their own retention, their own compaction claim, their own ACL. The
stream is unified because filtering is cheap in memory over the last few
seconds; storage is partitioned because retention, compaction and access control
are all per-series questions, and mixing a 1 Hz GPS track into the same objects
as an occasional log line would make every one of them worse.

## The module boundary

Two modules, stacked, each with one job. `app/src/events/` is the stream;
`app/src/series/` is the storage engine. Above them, the API routes; below them,
the storage adapter. Neither is a shared utility and nothing else in the
codebase reaches into either.

**What `#series/` may import.** `#files/storage.ts` for the adapter,
`#db/client/store.ts` for its own table, `#config` for its budgets,
`#observability/logger.ts`. Not `#acl`, not `#realtime`, not `#jobs`, not
`#api`, and not `#events` — a module that knows who is calling it, or who wants
to hear about the write, has stopped being a storage engine.

**What may import `#series/`.** The four route modules, one maintenance
entrypoint the cron tick calls, and the sink. That is the entire list, and it is
worth writing down because it is the property that makes the module replaceable:
the layout, the format and the query executor can all change without a caller
noticing.

**What `#events/` may import.** `#series/query.ts` for the predicate type and
its evaluator, `#config`, `#observability/logger.ts`. The bus itself imports
nothing else at all — it is a `Set` of listeners and a filter. The sink adds
`#series/store.ts`, and that is the only place in the codebase where an event
becomes a point.

**What may import `#events/`.** The ingest route, the realtime fan-out, and the
sink's own entrypoint. A producer publishes; it does not subscribe.

**Enforced, not just documented.** `app/test/egress-call-sites.spec.ts` already
does exactly this for server-side `fetch` — an inventory keyed by file, with a
`why` for each entry, that fails when a new call site appears. A sibling spec
takes the inventory of files importing `#series/` and `#events/`, so a new
importer of either is a failing test that someone has to justify rather than a
review someone has to catch.

Two things follow from the boundary, and they are the reason to state it up
front rather than treat it as tidiness:

- **Access control lives entirely in the routes.** The module takes a
  `SpaceStore` and a series name; it never sees a user, a token, or a
  permission. Every caller therefore goes through the same check, because there
  is no other way in.
- **The storage module reports what changed and tells nobody.**
  `appendPoints` returns `{ latestTs, count }` and emits nothing. Audiences are
  a product decision, and the engine has no opinion about audiences — the bus
  is where that decision is made, once, for every kind of event.

The `series` table is the module's own. No other repository selects from it or
joins against it; the only reference across the line is its `document_id`
foreign key, which points outward and is read by nothing but the cascade.

## Layout

```
series/{name}/{window}/s-{arrival}-{uuid}.tsc.br  a segment  (written by an append)
series/{name}/{window}/c-{watermark}.tsc.br       a chunk    (compacted from segments)
```

- `{name}` is the series' handle, e.g. `gps:vehicle-7`, and its row's primary
  key. It is a key segment, so it is validated on declaration against a pattern
  like `GROUP_NAME_PATTERN` — `containedKey` would refuse a traversal anyway,
  but a name that cannot be a key should be rejected where it is chosen, not
  where it is used. It is also immutable: renaming a series would mean copying
  every object it owns, which is why the row has no separate id to rename
  around.
- `{window}` is the zero-padded start of a fixed-size time window (an hour by
  default, declared per series). Zero-padded because both adapters list
  lexically — `list` walks a prefix and sorts, S3 returns keys in order — so
  padding is what makes lexical order equal time order.
- `{arrival}` is when the server received the batch, not when the points
  happened. `{watermark}` is the greatest arrival a chunk has absorbed.

There is no declaration object and no lease object: the row is the declaration,
and the claim is a column on it. Neither adapter's `list` supports a delimiter —
a listing returns every nested key — so a roster kept in storage would have been
a scan of every chunk in the space. In SQL it is one query.

The prefix stays out of the uploads listing and the file search index for the
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

**3. Compaction is single-writer, and never deletes.** The claim is one row
update — `UPDATE series SET compacting_at = ? WHERE name = ? AND (compacting_at
IS NULL OR compacting_at < ?)`, read back to confirm it is ours: the
compare-and-swap-and-verify `claimMigrationLock` already uses, with a TTL so a
process that dies mid-compaction parks the series for minutes rather than
forever. A claim is coordination, not data — dropping the column loses nothing.
Compaction then reads the window's current chunk and its live segments, writes
`c-{watermark}` with `ifNoneMatch`, and stops.

Deleting what the new chunk absorbed is the sweep's job, once those objects are
past a grace period. That is not tidiness, it is what removes the last race in
the design: a reader that has just listed a window would otherwise find segments
deleted underneath it before it could fetch them, and the only repair would be
treating a 404 mid-read as "compaction happened, start again". With a grace
period longer than any read, a listed object is still there when the read
reaches it.

Everything a crash can leave behind reads correctly under rule 2: an abandoned
chunk with a lower watermark loses to the live one, and segments the winning
chunk names are skipped whether or not they have been collected yet. Nothing is
ever acknowledged to a writer and then lost, and no point is ever read twice.

**Late points need no special case.** A point whose event time falls in a window
that was compacted long ago arrives with a *new* arrival stamp, becomes a
segment in that window, and reopens it for compaction. That is the reason
precedence is arrival-based rather than event-time-based.

## The chunk and segment format

An object is **framed**: an eight-byte zero-padded decimal length, a plain JSON
header, then the brotli-compressed columnar body.

```
00000412{"v":1,"name":"gps:vehicle-7",…}<brotli columnar body>
```

The frame exists so the header can be read without the body. `readStream` takes
a `ByteRange` on both adapters, so a planner can pull the first 16 KiB of a
candidate object — enough for the prefix and any plausible header — decide from
its statistics whether the object can contain a matching point, and never
transfer the body at all. A header larger than that is completed by a second
range read using the length the prefix states; that is arithmetic, not a guess.

The header:

```jsonc
{
  "v": 1,
  "name": "gps:vehicle-7",
  "window": 1764547200000,
  "count": 3600,
  "from": 1764547200000,      // first and last event timestamp in the body
  "to": 1764550799000,
  "columns": {                // per column, what a planner needs to prune
    "speed":   { "type": "number", "min": 0, "max": 31.4, "nulls": 0 },
    // Low cardinality: the exact distinct set, so equality prunes.
    "type":    { "type": "string", "nulls": 0, "values": ["gps.fix"] },
    "level":   { "type": "string", "nulls": 0, "values": ["info", "error"] },
    // Too many distinct values for a set: a bloom filter instead.
    "traceId": { "type": "string", "nulls": 0, "bloom": "…base64…" },
    // Neither: no equality pruning, and the planner knows it.
    "message": { "type": "string", "nulls": 0 }
  },
  "subsumes": ["s-000…-a1b2"] // chunks only: the segments absorbed
}
```

The body:

```jsonc
{
  "t0": 1764547200000,        // first event timestamp, absolute
  "dt": [0, 1000, 1000, 999], // deltas from the previous point
  "columns": {                // one array per field seen, nulls where absent
    "speed": [0, 4.2, 11.9],
    // A column with a `values` set is dictionary-encoded: indices into it.
    "level": [0, 0, 1, 0],
    "message": ["…"]
  }
}
```

Columnar for three reasons, and the third is the one that matters most here:
columns of like values are what makes a compressor earn its keep; `JSON.parse`
over a handful of arrays is a different order of cost from parsing 50 000 small
objects; and a query touches only the columns it names. `speed > 30` is a loop
over one numeric array, not a property lookup on every point, and a query that
never mentions `message` never materialises it.

Columns are discovered from the points rather than declared per kind: a writer
that adds a field gets a new column, and older objects simply lack it — which is
what `nulls` in the header is for.

**String columns carry their own distinct set, and that is what makes filtering
cheap.** `min`/`max` prunes a numeric predicate well and an equality predicate on
a string not at all, so a header that said only `{"type":"string"}` would leave
every object in the range to be decoded — the filter would be honest and the
cost would be a full scan. Instead the writer counts distinct values per string
column as it encodes:

- at or under `SERIES_MAX_COLUMN_VALUES`, the exact set goes in the header as
  `values`, and the column is dictionary-encoded in the body. `type = "gps.fix"`
  and `level in ["error","warn"]` are then answered against the header, and a
  `groupBy` on that column knows its groups before decoding anything;
- above it, a bloom filter sized to the column's cardinality. It answers
  "definitely absent" for `eq` and `in`, which is the direction pruning needs;
  a false positive costs a decode and never a wrong row. This is what makes a
  high-cardinality id — a run id, a device id, a trace id — a usable filter
  instead of a full scan;
- `contains`, `lt`/`gt` on strings, and anything else get neither, and the
  planner treats the object as a candidate. That is correct and it is slow, and
  the response's `scanned` counts say so.

The exactness matters more than the speed: a `values` set that omitted a value
the body contains would prune an object that should have been kept and return a
quietly wrong answer. So the set is computed from the encoded points, not passed
in by the caller, and the pruning-parity test at the end of this document is what
guards it.

Compression is async brotli on libuv's threadpool with the quality drop for
large payloads, copied from `compressRevisionContent` — `#db/space/revisions.ts`
carries the comment about what synchronous zlib did to Bun's event loop. The
header is left uncompressed on purpose: it is small, it is read far more often
than the body, and compressing it would put a decompress in front of every
pruning decision.

`v` covers the body encoding, which is where this is expected to change: typed
binary columns with their own offset table, so a single column can be ranged out
of the body. The header, the frame and everything reading them stay as they are.

## The `series` table

The one table, added by migration `3`. One row per stream, so it grows with
streams and not with points.

```ts
export const series = sqliteTable(
  "series",
  {
    /** The handle, the storage key segment, and the identity. Immutable. */
    name: text("name").primaryKey(),
    /** Payload shape: "gps" | "log" | "metric". Picks the validator and the view. */
    kind: text("kind").notNull(),
    /** Owning document. The cascade is the whole cleanup story; see below. */
    documentId: text("document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    windowSeconds: integer("window_seconds").notNull(),
    /** Retention window in days. Null keeps every window. */
    retentionDays: integer("retention_days"),
    /** Segments in a window before it is compacted ahead of closing. */
    compactAfterSegments: integer("compact_after_segments").notNull(),
    /** A compactor's TTL'd claim on this series. Coordination, never data. */
    compactingAt: integer("compacting_at", { mode: "timestamp_ms" }),
    /**
     * Advisory, so the tick finds work in one query instead of a listing per
     * series. `lastAppendAt` moves once per append batch, not per point; a
     * stale value costs a late compaction and never a point.
     */
    lastAppendAt: integer("last_append_at", { mode: "timestamp_ms" }),
    lastCompactedAt: integer("last_compacted_at", { mode: "timestamp_ms" }),
    /** Cache for a settings view, rebuildable by listing. Cosmetic when wrong. */
    pointCount: integer("point_count").notNull().default(0),
    byteCount: integer("byte_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [index("series_document_id_idx").on(t.documentId)],
);
```

`name` is the primary key rather than a generated id, because the name *is* the
prefix: an id to rename around would imply a rename, and renaming a series means
copying every object it owns. A space has its own database, so uniqueness across
the space costs nothing extra.

Only `document_id` is indexed. The tick's query — series whose `last_append_at`
is past their `last_compacted_at` — compares two columns and is a scan, which is
the right call at one row per stream and the wrong one to pre-optimise.

A point for a name with no row is refused. That is the cardinality guard:
without it a buggy extension mints unbounded stream names, and here that means
unbounded prefixes.

What a lost table costs, stated plainly: the declarations, and with them
retention and ownership — not a single point. Every object carries its own name
and window, so a recovery command can walk the prefixes and re-declare what it
finds with default policy. That is the price of not keeping a second copy of the
declaration in storage, and it is the cheaper side of the trade.

## Reads

`readSeriesPoints(store, name, { from, to, where, limit, cursor })` — the raw
points, in event order:

1. Compute the windows `[from, to]` covers — arithmetic on `windowSeconds`, not
   a listing.
2. For each, `list` the window prefix, pick the chunk with the greatest
   watermark, and read it plus every segment it does not name — the windows
   fetched concurrently, since they do not depend on each other.
3. Merge by event timestamp, apply the same `where` predicates the aggregate
   query uses, and page.

Predicates are shared with `## Querying` deliberately: a log panel filtering to
`level = "error"` and a chart counting errors per minute should not be able to
disagree about what an error is.

Steps 2 and 3 read no row: the row is consulted once, before them, for
`windowSeconds` and the access check. The merge is answered entirely out of
storage, so the number of points a series holds has no bearing on how much
database work a read does — which is the property the whole layout exists for.

The cursor is the existing `encodeSeekCursor` with a string id — `{objectKey}:{offset}` — so a page boundary is exact wherever it falls, including
inside an object.

Objects are immutable, so an LRU of decoded objects keyed by storage key needs
no invalidation at all; it is capped by decoded bytes. A window's *listing* is
not immutable — a late point can add a segment to a window compacted months ago
— so listings are cached with a short TTL, dropped locally for the window an
append just wrote to. Dropping the whole cache loses nothing: the same property
`#git/cache.ts` calls "a cache in the strict sense".

`latestPointWithin(store, name, maxWindows)` answers the live map pin and the
"last seen" label: walk back from the current window at most `maxWindows` and
return the newest point found. It is bounded on purpose and its name says so —
finding the last point of a series silent for a year would mean listing its
whole history, and "no point in the last N windows" is the honest answer for a
view showing where something is *now*.

## Querying

Two shapes of read, because they are genuinely different jobs: `points` returns
the points, `query` returns aggregates over them. Both are answered by the same
scan, so the machinery below is shared.

### The request is a typed object, not a language

```ts
export interface SeriesQuery {
  /** Required. The partition key: a query is always bounded in time. */
  from: number;
  to: number;
  /** ANDed. A point matches when every predicate holds. */
  where?: SeriesPredicate[];
  /** Bucket width in ms. Omitted, the whole range is one bucket. */
  every?: number;
  /** One row per bucket per group. Cheap over a `values` column; see below. */
  groupBy?: { column: string };
  /** What to compute. `count` needs no column. */
  select: SeriesAggregate[];
}

export type SeriesPredicate =
  | { column: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; value: number | string }
  | { column: string; op: "in"; value: Array<number | string> }
  | { column: string; op: "contains"; value: string }
  | { column: string; op: "exists" };

export type SeriesAggregate =
  | { fn: "count" }
  | { fn: "sum" | "avg" | "min" | "max" | "first" | "last"; column: string };
```

Deliberately not a query language. It is JSON, so it travels in a request body,
in a workflow script through `apiFetch`, and into a client's query key
unchanged; it is exhaustively validated, since every arm is a literal union; and
it cannot grow accidental expressiveness the executor then has to honour. The
client builds the same object the executor consumes, so the wire format is the
internal one.

Two guards, as assertions rather than clamps — a query that would not answer
what was asked should say so:

- `(to - from) / every` must not exceed `SERIES_MAX_BUCKETS`. Buckets are a
  dense array of accumulators, so this is what stops one request allocating
  unboundedly.
- a `groupBy` column must not produce more than `SERIES_MAX_GROUPS` distinct
  values in the range.

### Only mergeable aggregates

`count`, `sum`, `min`, `max`, `first` and `last` all combine from partial
results; `avg` is never stored or merged, it is derived from `sum` and `count`
at the end. That is the whole reason the set looks like this: an aggregate that
merges can be answered from a pre-computed coarser summary, and one that does
not have to re-read every point forever. Exact quantiles are the aggregate that
cannot merge, which is why they are out (see Non-goals).

Grouping over a column with a `values` set is the cheap case, and it covers the
common questions — errors against warnings over time, events per `type` — in one
pass: the groups are known from the headers before a body is decoded, so the
accumulators are allocated once and the column is read as dictionary indices
rather than strings. Grouping by a column without one works the same way but
learns its groups as it decodes, which is where `SERIES_MAX_GROUPS` earns its
keep.

### The plan, and why its cost is known before it runs

1. Resolve the windows `[from, to]` covers — arithmetic on `windowSeconds`.
2. List those windows concurrently; apply rule 2 to get the live object keys.
3. Read each candidate's **header only**, by range read, and drop the object if
   its `[from, to]` misses the range, or a predicate cannot hold: `speed > 30`
   against a header whose `speed.max` is `31.4` survives, against one whose max
   is `12` does not; `level = "error"` against a `values` set without it does
   not, and `traceId = "…"` against a bloom that says absent does not. This is
   row-group pruning, and it is why the header carries statistics.
4. Sum `count` over the survivors. **If that exceeds `SERIES_MAX_SCAN_POINTS`,
   refuse the query** — before transferring a byte of any body, naming the
   number it would have scanned. A query's cost is knowable in advance because
   every candidate states its own size, which is worth more than a timeout: the
   caller gets a number and a narrower range to retry with, not a dead request.
5. Decode the surviving bodies, touching only the columns the query names,
   evaluate the predicates column-wise into a mask, and fold the masked points
   into their buckets.

Steps 3 and 5 read through the same immutable-object cache as any other read, so
a dashboard refreshing a range it has already seen does no storage I/O at all.

The response says what answered it, because a query planner that silently picks
a cheaper source is a query planner nobody can debug:

```jsonc
{
  "rows": [{ "ts": 1764547200000, "group": "error", "count": 12, "avg": { "speed": 11.4 } }],
  "scanned": {
    "objects": 3, "prunedObjects": 21, "points": 10800, "source": "chunks",
    // Which predicates the headers could answer, and which needed a decode.
    "prunedBy": ["type", "level"], "scannedFor": ["message"]
  }
}
```

`prunedBy` and `scannedFor` are there because the difference between a filter
that prunes and one that does not is three orders of magnitude, and it is
invisible from the outside: a `contains` on `message` reads every body in the
range while an `eq` on `type` reads almost none. A caller that can see which of
its predicates did the work can move the cheap one first or narrow the range,
rather than concluding the store is slow.

The executor returns rows. It does not know what a chart is, and the chart does
not know what a chunk is.

### Rollups, once this is real

The scan is bounded by how many points a range holds, so a month of 1 Hz data is
2.6M points and no amount of pruning changes that when the query has no
predicate. The answer is to precompute: when compaction seals a window it can
also write

```
series/{name}/{window}/r{every}-{watermark}.tsc.br
```

— the same framed format, whose points *are* buckets, carrying `count`, `sum`,
`min`, `max`, `first` and `last` per column. A query whose `every` is a multiple
of a rollup's granularity is then answered from rollups: same code path, far
fewer points, and the identical number, which is exactly what "only mergeable
aggregates" bought. `source` in the response says `rollups` when that happened.

A predicate on a column cannot be answered from a rollup that is not grouped by
it, so a filtered query reads raw chunks. That is the planner choosing a source,
not a fallback hiding one: `scanned` reports which, and a test asserts both
paths return the same rows.

This is step 8 in the order of work, not step 1. The query API is designed for
it now so that adding it later changes no caller.

## Writes

`appendPoints(store, name, points)` — read the row, validate against its kind,
group the points by window, and write one segment per window. Bounded by
`SERIES_MAX_BATCH`. Nothing to lock. The only row write is `lastAppendAt`, once
per call: a batch, not a point.

`compactWindow(store, name, window)` — rule 3 above, stamping `lastCompactedAt`
and the counters as it releases the claim.

`pruneSeries(store, name, now)` — delete every key under the windows that
expired since the last prune. The expired windows are computed from the clock
and `retentionDays`, so pruning never lists a series' history; it lists and
deletes a bounded, known set of window prefixes.

`recoverSeries(store)` — walk `series/` and re-declare any name with no row,
taking `windowSeconds` from an object's header and the rest from defaults. Not
on any hot path: it is what the CLI runs after a database is restored from a
backup older than its storage, and what the truncate test exercises.

`sweepSeries(store, name)` — modelled on `sweepOrphanedPacks`: within a
window, delete the chunks that lose to the winner and the segments the winner
names. Skips anything whose `updatedAt` is inside the grace period, so neither
an object being written right now nor one a reader is mid-fetch on is ever taken
for a leak.

## What the table is for

Four jobs, none of which storage does well, and none of which is a copy of
something storage already says:

- **Ownership.** `documentId` with `onDelete: "cascade"`. The row goes when its
  document does, which is the entire cleanup story: no delete hook to write, no
  sweep reconciling declarations against documents that no longer exist. The
  objects are then collected by the sweep, which deletes the prefix of a name
  that has no row.
- **Access control.** A series with a `documentId` is governed by that document:
  `verifyAccess(… ResourceType.DOCUMENT …)`, which walks the `parent_id` chain,
  so a child document inherits its parent's grants. Without one, the space's own
  role decides. Reads need `Permission.VIEWER`, writes `Permission.EDITOR`. No
  new `Feature` — nothing here is grantable independently of the role. As a
  join it costs nothing; as a JSON object per request it would be a storage
  round trip on the hot path of every read.
- **Policy.** Retention, window size and the compaction threshold, edited in one
  transactional `PATCH` rather than a read-etag-modify-conditional-write against
  an object.
- **Coordination and the work queue.** The compaction claim, and the two
  advisory timestamps that let the tick ask "which series have appends newer
  than their last compaction" in one query rather than listing every window of
  every series.

Nothing above is on the read path for points, and nothing above is derived from
the objects — except the two counters, which are labelled a cache and are
cosmetic when wrong.

## Realtime

Realtime is a bus subscriber, and the only one besides the sink. It is not a
producer, and no route emits a series change of its own — which is the property
that makes a new kind of event show up in every view that wants it without
anyone wiring it there.

`SpaceChange` gains one variant in `#realtime/changes.ts`:

```ts
| { kind: "series"; name: string; documentId: string | null; latestTs: number; count: number }
```

Two topics carry it, and the split follows the rule `subscriptions.ts` already
enforces:

- `realtimeTopics.series(name)` — authorized against the series' owning
  document, the way `isDocumentRealtimeTopic` and `isWorkflowRunRealtimeTopic`
  already resolve their topics. This is what a run's log panel or a vehicle's
  map pin subscribes to.
- `realtimeTopics.events` (`"space:events"`) — the firehose, joining
  `realtimeSpaceTopics`. It carries data from anywhere in the space, so no
  per-resource check could scope it to a document-level grantee, which is
  exactly the reason that set exists. A space role, or nothing.

**The socket carries notifications, not payloads, and that is deliberate.**
`#realtime/events.ts` coalesces per space over a 100 ms debounce and keeps 256
envelopes of history for reconnects — both of which work because an envelope
says *something changed*, and neither of which survives an envelope carrying
data: you cannot coalesce two log lines into one, and a history window of 256
lines is a tail that silently drops. So the change carries `latestTs` and
`count`, and the client refetches the range it is showing, as everywhere else in
the sync layer. A live tail is a short-range query re-issued on notification,
and it reads through the same immutable-object cache as any other.

The consequence worth stating: **a subscriber's filter runs server-side on the
bus, a client's filter runs in its query.** They are the same predicate objects
and the same evaluator, but a websocket client is not a bus subscriber — it is
told to look again, and looks with the filter it already has.

ACL is checked when a topic is subscribed, not per event, because that is what
the existing fan-out does and per-event checks would put an `#acl` call on the
hot path of every event. It follows that a topic has to be scopeable to a
resource at subscribe time, which is why the firehose topic is space-role-only
rather than a filter the client gets to choose.

Compaction emits nothing: it moves points between two representations a read
already merges.

## API

Registered in `#api/routes.ts`, documented by the JSDoc tags the OpenAPI
generator reads. The series is addressed by name, since that is what the layout
is keyed on and there is no id to look one up by:

| Route | Methods | Role |
| --- | --- | --- |
| `/api/v1/spaces/[spaceId]/series` | `GET`, `POST` | list / declare |
| `/api/v1/spaces/[spaceId]/series/[name]` | `GET`, `PATCH`, `DELETE` | read / retention / remove |
| `/api/v1/spaces/[spaceId]/series/[name]/points` | `POST` | append a batch |
| `/api/v1/spaces/[spaceId]/series/[name]/points` | `GET` | the points in a range (`from`, `to`, `where`, `@paginated`) |
| `/api/v1/spaces/[spaceId]/series/[name]/query` | `POST` | aggregates over a range, body is a `SeriesQuery` |
| `/api/v1/spaces/[spaceId]/events` | `POST` | publish a batch of `SpaceEvent`s |

`POST /events` is the ingest edge and the route a producer actually uses: it
validates the batch, resolves each event's `series` from its `type` and subject,
checks `Permission.EDITOR` on each distinct series' document — once per series
per request, not once per event — and publishes. It returns when the batch is on
the bus, which is *not* when it is durable; a producer that needs the stronger
answer posts to `points` instead and waits for the append. Both routes exist on
purpose, and the difference between them is one sentence in each one's JSDoc.

`POST .../points` stays as the direct, durable path, and it does not go through
the bus — which means it emits no realtime change and reaches no subscriber. It
is the escape hatch, not the front door, and the one place worth checking when a
write lands in storage and nothing lights up.

`query` is a `POST` because its request is a structured object, not because it
changes anything: it is idempotent and safe to retry, and it is not
`@paginated` — a bucketed answer is bounded by `SERIES_MAX_BUCKETS`, so there is
nothing to page. A query that would scan too much is refused with the count it
would have scanned, which is a 400 about the request rather than a 500 about
the server.

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

Discovering what to compact is one query per space — the series whose
`lastAppendAt` is past their `lastCompactedAt` — plus one listing per candidate
window. An idle series costs nothing, which is the point of keeping those two
timestamps.

The sweep also deletes the prefix of any name that has no row, which is how a
series whose owning document was deleted loses its objects: the cascade takes
the row, and the next sweep takes the bytes.

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
- `VEKTOR_SERIES_MAX_SCAN_POINTS` — points one query may scan after pruning
  before it is refused; `5_000_000`.
- `VEKTOR_SERIES_MAX_BUCKETS` — buckets one query may ask for; `10_000`.
- `VEKTOR_SERIES_MAX_GROUPS` — distinct groups one query may return; `1_000`.
- `VEKTOR_SERIES_MAX_COLUMN_VALUES` — distinct values a string column may have
  before its header carries a bloom filter instead of the exact set; `256`.
- `VEKTOR_EVENTS_FLUSH_MS` — how long the sink holds events before appending,
  and therefore the durability window for everything on the bus; `1000`.
- `VEKTOR_EVENTS_FLUSH_POINTS` — events the sink holds before appending early;
  `500`.
- `VEKTOR_EVENTS_SUBSCRIBER_QUEUE` — events a slow subscriber may fall behind
  before it is dropped; `10_000`.
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

One series per run, declared over the API — `POST /series`, which is idempotent
by name, so a retry is harmless. It cannot be part of `createRun`'s transaction,
because an HTTP request is not: the run document is inserted, then the series is
declared. A run whose declare never succeeded logs nothing until the next
attempt, and if it is deleted first the row cascades away and the sweep takes
whatever objects existed. The declaration:

- `name`: `workflow-run:{runId}`
- `kind`: `log`
- `documentId`: the run document, so ACL resolves through the `parent_id` walk
  to the workflow document's grants — the same verdict the run route reaches
  today by checking `run.documentId` — and so deleting the run cascades the row
  away and the next sweep takes its objects, `clearRunStoreForTests` included.
  It is also what authorises the writes: a job token scoped to the run reaches
  the append route as an ordinary `authenticateJobTokenOrSpaceRole` caller.
- `windowSeconds` short, and `compactAfterSegments` low: a run is minutes, and
  a finished one should settle into a single chunk that reads in one fetch.
- `retentionDays` from config: the first bound run logs have ever had.

One event per line: `type` is `workflow.log`, `level` is the column that was
going to be a label, and `message` carries the text. `run.error` becomes an
event at `level: "error"` rather than a field the view concatenates onto the end
of the array; it stays on the run document too, since that is what the status
badge reads.

`runId` goes on the event as a column even though the series name already
encodes it, and that is the one piece of deliberate redundancy here: it is what
makes the run's lines findable in a cross-run query later, and a bloom in every
header is what makes that query cheap. A column that is constant within an
object costs one dictionary entry.

### Writes go to the bus, batched

`runStore` does not import the series module, and it does not import the bus
either. It posts to `/events`, the way `#jobs/runtime/capabilities.ts` already
calls this instance's own API: an origin from `getLocalOrigin()` and a job token
in `X-Job-Token`. The new call site goes in `egress-call-sites.spec.ts`'s
inventory with its `why`, beside the two that are there for the same reason.

That is a loopback request, and it is worth what it costs. The alternative is a
privileged in-process publish that no ACL check covers — which is the back door
every log writer would then be tempted through. This way a workflow's log lines
are authorised, rate-limited and validated by exactly the same route as a device
posting positions.

A request per log line would be absurd, so `appendRunLog` keeps pushing to
`run.logs` — the array survives, its meaning narrows to *lines not yet sent* —
and a flush posts the batch on the per-run promise chain `persistNow` already
uses. Flush on a line count or an elapsed interval, whichever comes first, and
always from `finalizeRun` and `cancelRun` before the run leaves `activeRuns`.
Reusing the existing chain is what keeps two flushes for one run from
interleaving; no new timer per run, and nothing that can spin.

There are now **two** buffers between a log line and an object — the run's array
and the sink's — and their intervals add up to the durability window. That is
worth naming rather than discovering: a crash loses at most the sum of the two,
where today it loses every line the run ever wrote. `finalizeRun` posts its last
batch and the sink flushes on shutdown, so an orderly end loses nothing.

Liveness comes for free: the bus produces the `{ kind: "series" }` change for
this writer exactly as for any other, so `appendRunLog` stops emitting anything
itself.

### Reads move to the client

`GET workflows/runs/{runId}` **loses** its `logs` field, and `WorkflowView`
reads the series endpoint directly through `useSeriesPoints`.

This reverses the earlier plan to keep `logs` for a release as a parity harness.
Under the boundary it would mean the run route doing a loopback GET on every
poll of a live run, to fill a field that is deprecated on arrival — worse than
the thing it was avoiding, which was editing two spec files. So: the field goes,
`workflow.spec.ts` and `jobs.spec.ts` assert the same lines against the series
endpoint instead, and the parity check survives in the form that matters — the
same log lines, read a different way.

It is the one breaking change here: the field is in the published OpenAPI schema
and `ApiClient`'s run detail type, and both change with it.

`readRunLogs` in `#jobs/` shrinks to the deprecated path only: a run predating
this carries `_workflowRunLogArtifactPath`, and its lines are read from that
`logs.json` through the existing `readWorkflowArtifact`. That touches the
storage adapter directly and never the series module, so the boundary holds, and
it can be deleted once old runs have aged out. There is no backfill.

The client side is a plain win: a level filter, paging, and a range query that
tails a live run instead of re-fetching every line it already has.

### What comes out

`writeRunLogs` and both its call sites in `workflowScript.ts`;
`runProperty.logArtifactPath` from `runProperties()`, so new runs stop writing
it; the `logs` array as a whole-run buffer; the `logs` and `logArtifact` fields
in the run response; and `WorkflowView`'s error-line concatenation.
`WorkflowArtifactKind` keeps `"logs"` (deprecated) only so old artifacts can
still be read back.

What does *not* come out, and is worth noticing: nothing in `#jobs/` gains an
import of `#series/`. The run store learns one endpoint and one token, which is
what it already does for every other capability.

## Order of work

1. `app/src/series/format.ts` — the frame, the header with its statistics, the
   columnar body, key naming — with its round-trip test, before anything
   depends on it. The header-only read is part of this step, not an
   afterthought: everything else is built on being able to judge an object
   without fetching it.
2. The `series` table and migration `3` (one `createTables` call and nothing to
   backfill), with its reads and writes in `app/src/series/declarations.ts` —
   inside the module, not in `#db/space/` beside the repositories other things
   share. The schema definition itself stays in `#db/schema/space.ts`, because
   that is where the migrator looks; it is the one thing about this module that
   is declared outside it, and it points one way.
3. `app/src/series/store.ts` — append, read, the decoded-object cache. No
   compaction yet: rule 2 reads a window of pure segments correctly, which is
   what makes it safe to land first.
4. Compaction, prune and sweep, then their due-checks on the tick.
5. `app/src/series/query.ts` — predicates as column masks, the mergeable
   aggregates, bucketing, and the planner: prune by header, refuse by count,
   decode the rest. Pure functions over decoded objects, with the planner the
   only part that touches storage. Before the bus, because the bus imports the
   predicate type and its evaluator from here and must not grow its own.
6. `app/src/events/` — the bus, then the sink. Small enough to land together,
   and the sink is what makes the bus testable end to end.
7. Routes — `/events`, `points`, and the declaration endpoints — the
   `SpaceChange` variant published from the bus, the two realtime topics, the
   route-access snapshot rows, the config entries, and the importer inventory
   spec that fixes both boundaries while the list of callers is still short.
8. Workflow run logs, as above.
9. `ApiClient` methods and the composable, then whatever view lands first — the
   run's log panel with a level filter, or a track on a map.
10. Rollups at compaction time, and the planner learning to prefer them. Nothing
    above changes: that is the point of only having mergeable aggregates.

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
  identically, and the sweep then removes exactly the garbage; a claim left
  behind by a dead process blocks compaction only until its TTL passes.
- Page a range across a boundary inside one object and across two objects.
- Assert a point for an undeclared series is refused, and that a viewer cannot
  append.
- Assert prune deletes the expired windows and leaves the live ones, and that
  deleting the owning document takes the row by cascade and the prefix on the
  next sweep.
The boundary gets its own spec, in the shape of `egress-call-sites.spec.ts`: an
inventory of the files importing `#series/`, each with a `why`, failing when a
new one appears. It is a cheap test and it is the only thing that keeps the
module a module a year from now.

Then the query path, where the risk is an optimisation that changes an answer:

- The same aggregate query answered with pruning enabled and with pruning
  forced off returns identical rows. A header statistic that prunes an object it
  should have kept is the one bug in this design that silently returns a wrong
  number instead of failing, so this is the assertion that guards it.
- A predicate that no object can satisfy returns empty rows having decoded no
  body at all — `scanned.objects` is `0` and `prunedObjects` is not.
- A query over more points than `SERIES_MAX_SCAN_POINTS` is refused before any
  body is read, and says how many it would have scanned.
- `groupBy: "label"` over a range spanning several objects with different label
  dictionaries returns one row per label per bucket, including labels absent
  from some objects.
- Bucket boundaries: a point exactly on a boundary lands in one bucket, and a
  range that is not a whole multiple of `every` still covers its last partial
  bucket.
- Once rollups land: the same query answered from rollups and from raw chunks
  returns identical rows, and `scanned.source` distinguishes them.

- **Delete every row in `series`, run the recovery command, and assert the same
  range reads identically.** This is the rule from the top of this document as a
  test: the objects hold every point and enough header to re-declare the series
  they belong to. If it ever stops passing, something has put a fact only the
  database knows into the read path.

For the run logs, `workflow.spec.ts` and `jobs.spec.ts` keep asserting on the
same log lines, read from the series endpoint rather than the run response —
that is the parity check, and the edit to those two files is the whole cost of
dropping `logs`. Three cases go beyond them: lines flushed before a simulated
restart are still readable afterwards (`resetRunStoreMemoryForTests` already
simulates the fresh process); a run's objects are gone once its document is
deleted; and a run whose series was never declared fails its appends without
failing the run, since a workflow that cannot log is still a workflow that
should finish.

## Non-goals

- **No exact quantiles.** A median cannot be merged from partial results, so it
  would forbid rollups for every series that wanted one and force a full scan
  in perpetuity. If a view needs `p95`, the honest options are an approximate
  sketch in the rollup or a bounded scan asked for explicitly — both are their
  own design, not a flag on this one.
- **No joins, no cross-series arithmetic, no expressions.** `select` names
  columns, not formulas. Comparing two series is the client putting two answers
  on one chart.
- **No spatial queries.** The question a GPS view asks is "this series, this
  time range". A bounding box in a chunk's header is where that would start.
- **No cross-space or cross-series reads.** A space is the boundary here as it
  is everywhere else.
- **No direct object URLs.** See the API section.
- **No unbounded "latest point".** See `latestPointWithin`.
