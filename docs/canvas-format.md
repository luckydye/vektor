# Canvas format

Canvases become a single binary wire format (`.vcanvas`) that is at once the stored file, the HTTP response and the live-op frame. It streams front to back, and a spatial index lets a reader fetch only the elements in view. Merging stays with Yjs: every element is its own small Y.Doc, and the format stores and ships their updates.

## Where we are

- A canvas is persisted as one JSON snapshot `{ version: 1, shapes, strokes }` in `document.content`, spilled to the blob store above 1 MB (`#db/space/documentContent.ts`).
- Live editing runs through a Yjs room over one Y.Doc per canvas. Every persist re-serializes the whole doc (`contentFromDoc` → `JSON.stringify`, throttled to 5 s because it stalls the event loop), and every load re-seeds a Y.Doc from JSON with pinned ids (`seedCanvasDoc`, `withPinnedYjsSeed`).
- Revisions brotli the full JSON (`#db/space/revisions.ts`), with quality dropped for large canvases.
- Strokes store points as `{ x, y, width }` objects. Images are already references.
- The canvas only uses Yjs as nested last-writer-wins maps (`canvas.shapes`, `canvas.strokes`): no `Y.Text`, `Y.Array` or `XmlFragment`.

Nothing can be loaded partially: a client needs the entire document before it renders anything, and the server needs it in memory to save. One Y.Doc cannot be loaded partially either: its item ids are `(clientID, clock)` with one clock per client across all elements, so an update to one element can depend on structs in elements the client never loaded, and Yjs holds it back as pending.

## Goals

- Load streams: the first elements render before the last byte arrives.
- Load is spatial: a client fetches the elements intersecting its viewport, and more as it pans.
- Saving costs the size of the edit, not the size of the document.
- The server never holds a whole canvas in memory, including during compaction.
- No new SQLite tables. The canvas lives in the blob store; the document row only points at it.
- One sync implementation: Yjs merges, as it does for every other document type.

## Non-goals

- Partial loading for the other Yjs-backed document types. Rich text stays on one Y.Doc per document.
- Offline editing. Yjs would merge offline edits, but resending them after a long disconnect is not designed here.

## Elements as Y.Docs

Every element (shape or stroke) is one Y.Doc whose root map `e` holds everything the client renders: `type`, `z`, `updatedAt`, `authorId`, `locked`, `deleted`, and for shapes the nested maps `frame`, `style`, `data`, for strokes `style`, `rotation`, `kind` and `points`. The keys and nesting are those of the maps in `canvas.shapes` and `canvas.strokes` today, so merge behavior does not change: concurrent edits to different keys both land, the same key resolves last-writer-wins.

Clocks are per element, so any element can be loaded alone. A session uses one random `clientID` for every element doc it edits.

Yjs updates merge in any order and applying one twice is harmless. The format relies on that: an element's state is the merge of every update stored for it, wherever they sit, and nobody (server or client) has to order, check or reject them.

`points` is a `Uint8Array` value:

```
scale varint                      // quantization, units per world unit
count varint
x0 y0 zigzag varint, w0 varint    // absolute, quantized
(dx dy zigzag varint, dw zigzag varint) × (count − 1)
```

The recorder picks `scale` per stroke: 16 × the zoom the stroke was drawn at, rounded up to a power of two, which keeps the error under 0.05 screen pixels at that zoom. A fixed 16 would put it at 0.7 px for a stroke drawn at 16×; the finer scale costs nothing there, because the deltas are small anyway (39 vs 40 bytes per stroke, see Prototype results). Re-encoding a stroke keeps its scale.

### Summary

The server indexes elements without reading Yjs. Every record therefore carries a **summary**: the element's `bbox`, its `refs` and whether it is deleted, computed by the client from the doc. The doc is the truth and the summary a cache of it for the index.

Summaries are last-writer-wins in server order, while docs merge. After two concurrent edits that both change an element's extent (one moves, one resizes), the merged doc can disagree with the last summary. A client that applies a record and computes a different summary from the merged doc writes a correction: a record with the new summary and an empty update. Every client computes the same summary from the same doc, so corrections converge after one round.

`bbox` is computed by the client, because only it can lay out text. It is rounded outward when narrowed to f32 (min towards −∞, max towards +∞): f32 resolution is about 0.1 world units far from the origin, and rounding to nearest would cull elements at the viewport edge. The server only asserts it is finite and ordered.

`refs` lists the elements this one is derived from: a connector's endpoints (which may be connectors themselves) live in its extension-defined `data`, which the server cannot read. Loads use it to return dependent elements together with what they depend on (see Loading). A ref may dangle: an element whose endpoint was deleted keeps its `refs`, and its type's `resolve` already handles a lookup that finds nothing.

### Deletion

Deleting sets `deleted` in the element's doc, so a delete merges like any edit and `Y.UndoManager` undoes it. The summary flag mirrors it for the server: deleted elements are left out of loads, and a base rewrite drops them. Undoing a delete after that sends the element's full state (summary flag `full`), which the client still holds through its undo stack; the server drops records without `full` for ids it no longer has, so stale updates to a long-deleted element vanish.

## File layout

```
magic "VCNV" (4 bytes) | version u8 | flags u8
record*
record = kind u8 | length varint | payload[length]
```

All varints are unsigned LEB128; signed integers are zigzag-encoded. Floats are little-endian. Every record decodes without reading anything after it, so a reader processes records as they arrive and skips unknown kinds by `length`.

Two concatenated streams form a valid stream once the second's preamble (magic, version, flags) is dropped. A file is the log of everything written to it: for any element id, the last record's summary wins and all its updates merge.

### Record kinds

| Kind | Name | Where | Payload |
|---|---|---|---|
| `0x01` | `header` | first record of a base | element count u32, document bounds (4×f32), offset and length of `index`, `ids` and `refs` (6×u64) |
| `0x02` | `index` | base | packed Hilbert R-tree (below) |
| `0x03` | `ids` | base | id lookup table (below) |
| `0x04` | `refs` | base | reverse reference table (below) |
| `0x10` | `element` | anywhere | id and summary, then a Yjs update (below) |
| `0x20` | `cursor` | load responses | `epoch` string, `seq` varint: the snapshot the response is consistent to |

The header is fixed-width so its offsets do not depend on their own encoded length. All offsets in a base (header, index leaves, `ids`, `refs`) are absolute u64 file offsets of a record's first byte, its `kind`. The format version is the preamble's `version` byte alone.

### `element`

| Field | Encoding |
|---|---|
| `id` | string (varint length + UTF-8) |
| `bbox` | 4×f32, world-space AABB including rotation and stroke width; for connectors, the union of the route and its endpoints |
| `refs` | count varint, ids |
| `flags` | u8 — `deleted`, `full` (the update is the element's whole state) |
| `update` | bytes: a Yjs update for the element's doc, empty for a summary-only record |

In a base, `update` is the element's whole state (`Y.encodeStateAsUpdate`). In segments and live ops it is the update a client produced; a create is its first update and carries `full`.

### `index`

A packed Hilbert R-tree, as in FlatGeobuf. Elements in a base are sorted by the Hilbert value of their bbox centre, which also makes elements close on the canvas close in the file. The tree is stored root-first; node size is 16. Each node entry is 4×f32 bbox plus a u64 offset: a child node index for internal entries, the file offset of the `element` record for leaves (≈ 24 bytes per element).

A query walks the tree with the viewport and returns leaf offsets, which collapse into a few contiguous byte ranges thanks to the Hilbert order; ranges less than 16 KB apart are read as one (4 ranges instead of 39 for a viewport at zoom 2, 15% more bytes). Size filters (`minSize`, `maxSize`) apply to leaves only: an internal node's bbox is large even when all its children are small, so a zoomed-out query visits every leaf in view.

The working set reads the whole `index` and `ids` of its base once and keeps them (40 bytes per element, 4 MB at 100k), so queries cost no range reads. Walking the index with a range read per node would take 67 reads for one viewport at zoom 1.

### `ids`

Fixed-width entries sorted by key, so a lookup is a binary search: `hash u64 | recordOffset u64`, where `hash` is the first 8 bytes of SHA-256 of the id. On a hash match the reader decodes the record and compares the full id, continuing over neighbouring entries with the same hash.

### `refs`

The same layout as `ids`, keyed by the hash of a referenced id: one `hash u64 | recordOffset u64` entry per (element, ref) pair, pointing at the referencing element. A lookup returns candidates whose `refs` field the reader then checks for the full id.

### Base file order

```
magic | header | index | ids | refs | element × n (Hilbert order)
```

The index precedes the elements, so a reader holding the header and index can range-read just the elements it needs. A base holds one record per id and no deleted elements.

## Storage

Per document, under the existing `documents/<id>/` blob prefix:

- `base-<uuid>.vcanvas` — the last base rewrite.
- `seg-<firstSeq>-<epoch>.vcanvas` — ordered segments since then: `element` records, no index. The epoch keeps names unique: after a crash a new epoch reuses the `seq`s that were never flushed.
- `merged-<lastSeq>.vcanvas` — the result of a segment merge, in the same list and order.

The manifest replaces the JSON snapshot in `document.content` (a few hundred bytes, never spilled):

```json
{
  "format": "vcanvas",
  "base": "base-….vcanvas",
  "segments": ["seg-1042-k3f9….vcanvas", …],
  "seq": 1107,
  "bounds": [x0, y0, x1, y1]
}
```

- `seq`: the last flushed `seq`.
- `bounds`: a superset of the document bounds. Flushes grow it; a base rewrite makes it exact again. The header's bounds are only valid for the base.

The row write is the commit point, as for spilled content today. The working set is the only writer of the manifest: flushes, compaction results and restores are committed one at a time, each as a read-modify-write of the current row.

Blobs no manifest, revision or open read references are garbage. A blob is written before the row that references it, so GC only deletes blobs older than one hour; a fresh segment or base is never collected between its write and its commit.

## Writing

The server keeps one working set per open canvas: its `epoch`, the `seq` counter, the records not yet flushed, the **segment map** `id → (summary, record locations)` for every element with records in the listed segments or the pending buffer, and its reverse `ref → ids`. Opening a canvas builds the map by streaming the segments once. The map is bounded by compaction and holds no payloads; the server never holds elements.

1. A client sends a `CanvasOps` frame: the `epoch` it holds, an `opId`, and `element` records.
2. The server checks write access and readonly, answers a frame from another epoch with `CanvasJoined` instead (see Durability), and checks each summary for well-formedness and size limits. It drops records without `full` for ids that exist in neither the map nor the base.
3. Each record gets the next `seq`, updates the segment map, is appended to the pending buffer, and the frame is broadcast to the room, the sender included, carrying its `opId`.
4. A flush (1 s after the oldest pending record, 64 KB pending, the last client leaving, server shutdown, or the working set being evicted) writes the pending records as `seg-<firstSeq>-<epoch>.vcanvas`, updates the manifest (`seq`, `segments`, `bounds`), and then broadcasts `CanvasFlushed` with the flushed `seq`.

Nothing is rejected and the server never reads an update: merging happens where the doc is needed.

**Gestures commit once.** A drag, resize or rotate writes the element's doc when the pointer is released, as strokes already do (`strokePreview`). Mid-gesture, the moving elements' offset or replacement geometry goes out through presence, so others see the drag live without a Yjs update per pointer event. A drag is one record per element, which also keeps each doc's history small (see Prototype results). An interrupted gesture commits nothing.

### Durability

Clients see ops at broadcast, before they are durable. A sender keeps every update it sent until a `CanvasFlushed` covers its `seq`.

A graceful shutdown or eviction flushes first. A crash loses the unflushed records, and the next open starts a new working set with a new `epoch`, continuing from the manifest's `seq`. The client cannot rely on its socket dropping to notice (a hibernated Durable Object keeps its sockets while its memory is gone), so every `CanvasOps` frame carries the epoch, and a frame from an old epoch is answered with `CanvasJoined` for the new one. On an epoch change, the client reloads its region and resends every update not covered by a `CanvasFlushed`, unchanged. Updates the server already had merge as no-ops. Nothing a connected client wrote is lost; updates from a client that is gone too are lost, at most one flush interval.

### Compaction

Compaction has two tiers, so its cost follows the edits, not the document. Both run in the serializer worker, one at a time per document, and hand their result to the working set, which commits it conditional on the manifest's base being unchanged (a restore during compaction discards the result).

**Segment merge**, size-tiered: whenever 4 adjacent segments are within 2× of each other in size, they are merged into `merged-<M>.vcanvas` (M their last `seq`): one record per id, with the latest summary and the updates combined by `Y.mergeUpdates`, which works on the encoded updates without loading a doc. A record is rewritten once per tier, the segment count stays logarithmic in the segments' total size, and no merge rewrites a large merged segment for a few small ones.

**Base rewrite**, when segments exceed 25% of the base's size (and at least 1 MB). It covers the segments present when it starts:

1. Stream base + segments, keeping only `id → (bbox, hilbert, refs, deleted, record locations)`. Memory is O(elements × ~60 bytes), never payloads.
2. Sort live ids by Hilbert value. For each changed element, load its base state and updates into a Y.Doc and re-encode it, which garbage-collects overwritten values (a dragged shape: 5.1 KB of merged updates, 1.9 KB re-encoded). Unchanged elements are not decoded.
3. Build `index`, `ids` and `refs` from the record lengths, and stream the output through `putStream`: header, index, ids, refs, then the elements. Unchanged elements are copied by one sequential read of the old base, which is already in Hilbert order for them.
4. Update the manifest to the new base plus the segments flushed since it started, with exact `bounds`. Drop the map entries it folded.

Clients are not told: their docs already hold everything the new base holds.

## Loading

`GET /api/v1/spaces/:space/documents/:id/canvas` returns `application/vnd.vektor.canvas`:

| Query | Returns |
|---|---|
| `view=x0,y0,x1,y1` | elements whose bbox intersects the rect |
| `minSize=s` | additionally skips elements whose bbox is smaller than `s` world units in both axes |
| `maxSize=m` | additionally skips elements whose bbox is at least `m` world units in either axis |
| `ids=a,b,…` | the named elements, via the `ids` table; combined with `view`, the union |
| none | every element (export, agent, search indexing) |

Matching uses the latest summary: the map's for elements with segment records, the base's otherwise. Deleted elements are skipped. Every response also includes the elements that reference a returned element, transitively (via the `refs` table and the map's reverse refs, with a visited set), so a client holding a shape holds the connectors attached to it, and the connectors attached to those.

The server queries the cached index and the segment map. It then streams:

1. A `cursor` record with the working set's `epoch` and current `seq`.
2. For each matching element, its base record (if any) from its byte ranges via `readStream`, then its segment records, by range read or from the pending buffer. The client merges them; the server does not.

Responses carry no `header`, `index`, `ids` or `refs`. A base or segment a response is reading stays in the blob store until the response ends: GC deletes a blob only once no manifest, revision or open read references it.

### Join order

The client joins the room before loading and receives the room's `epoch`. A response whose `epoch` differs is discarded and retried.

While any region request is outstanding, the client keeps every live record for an element it does not hold, and merges those records into the element when a response delivers it. Otherwise an op that moved an element away while the response was reading it would never reach the client, which did not hold the element yet, and the response's older state would stay. Kept records are dropped once every request that was outstanding when they arrived has finished.

## Live protocol

New `WsMsgType`s in `#realtime/protocol.ts`, framed like the Yjs frames: `[type u8][documentId length u32 BE][documentId UTF-8][payload]`. Op payloads use the format's encodings; the small control payloads are JSON, as the existing JSON frames are.

| Type | Frame | Direction | Payload |
|---|---|---|---|
| 16 | `CanvasJoin` | client → server | empty |
| 17 | `CanvasLeave` | client → server | empty |
| 18 | `CanvasJoined` | server → client | JSON `{ epoch, seq, bounds }` |
| 19 | `CanvasOps` | client → server | `epoch` string, `opId` string, records |
| 19 | `CanvasOps` | server → client | `opId` string, first `seq` varint, records |
| 20 | `CanvasFlushed` | server → client | JSON `{ seq, bounds, changed }` — `changed`: the union bbox of the flushed records |
| 21 | `CanvasReload` | server → client | JSON `{ epoch, seq }` — after a revision restore |

Records are the file's records, `kind | length | payload`, so a client decodes live ops and load responses with the same decoder.

Every op goes to every room member, on one ordered socket per client. Clients apply every record for an element they hold, whose `refs` name an element they hold, or whose bbox lies in the loaded region, and keep the rest while requests are outstanding (see Join order). An element's summary is replaced only by one with a higher `seq`; records from a response count as `cursor`. Presence stays on the existing presence rooms, which also carry gesture previews.

### Walkthrough

Clients P and Q have loaded a region holding shape A and connector C (`refs` [A]). R is joined but has not loaded A's area.

| # | What happens | Server | Clients |
|---|---|---|---|
| 1 | P drags A | | presence carries A's offset; Q and R render A moving |
| 2 | Q recolours A mid-drag | Q's update (`style.color`) gets seq 101 | P and Q merge it; P keeps previewing its drag on top |
| 3 | R starts loading A's area | response cursor 101; it reads A's base record and update 101 | |
| 4 | P releases: A's doc gets `frame.x`, `frame.y`, the summary the new bbox (outside R's region); C gets a summary-only record with its new bbox | seqs 102–103, broadcast | Q merges: A has P's position and Q's colour |
| 5 | Op 102–103 reaches R before the response's A | | R does not hold A, a request is outstanding: kept |
| 6 | The response's A arrives | | R merges the kept 102 into it: A is where P put it, outside R's region |
| 7 | Q resizes A at the same moment as P moves it again | both updates accepted, seqs 104, 105; the last summary is Q's, with Q's old position | everyone merges position and size; P's and Q's clients see the summary disagree with the doc and each write the same correction, 106–107 |
| 8 | Flush | `seg-101-E.vcanvas`, `CanvasFlushed` 107 | P and Q drop updates kept for resend up to 107 |

Every client ends with the same doc for A, and the index with A's true bbox.

## Client

The canvas controller replaces the room-wide Y.Doc and its `observeDeep` sync (`#canvas/runtime/controller.ts`) with:

- **Element store**: for each held element, its encoded state and its decoded value. Incoming records are merged with `Y.mergeUpdates` and decoded through a short-lived Y.Doc (3000 elements in 44 ms). A Y.Doc costs about 8 KB in memory against 0.4 KB for bytes and value, so a doc is kept only for elements being edited or in the undo stack.
- **Streaming decoder**: merges elements into the store as records arrive and requests a render per batch.
- **Region loader**: below the overview zoom it shows overview tiles instead (see Levels of detail). Otherwise, on viewport change, it requests the viewport padded by 50%, and passes `minSize` = one screen pixel in world units. The loader records each loaded rect with the `minSize` it was loaded at. A request covers only what no loaded rect covers at that `minSize` or finer; where a rect was loaded coarser (the user zoomed in), it requests that area with `maxSize` = the old `minSize`, fetching just the elements the coarser load skipped. Elements beyond 3× the viewport are evicted unless selected, being edited or in the undo stack, and evicting them shrinks the loaded rects to match.
- **Op writer**: sends each local transaction's update with the summary computed from the doc. Editing a shape also sends summary-only records for the connectors that reference it, so their bboxes stay true; the client holds them, because every load returns referencing elements with what they reference.
- **Undo**: a `Y.UndoManager` per element doc, tracking local origins, under an app-level stack that groups the elements one user action touched; undoing pops a group and undoes each. Remote edits to other keys survive, as today.

The client never assumes it holds every element:

- **Fit to content, minimap**: use the manifest's `bounds`, sent in `CanvasJoined` and updated with each `CanvasFlushed`.
- **Select all, search**: query the server.
- **Moving a section**: loads the section's bbox first, so contained elements are present.
- **Connectors**: load off-view endpoints with `ids=`.

## Levels of detail

Size culling is not a level of detail. On the 100k-stroke prototype board, a 1920×1080 viewport at zoom 0.05 still matches 47k elements (12.5 MB); at zoom 0.01, `minSize` = 1 px sends 22.7 MB, and 4 px sends nothing, so the board goes blank. Most of a record is fixed cost, so simplified points would not help either: zoomed out, the element count is the cost.

Below an overview zoom of 1/4, the client stops loading elements and draws **overview tiles**: 256 px PNG tiles in a power-of-two pyramid, served from `GET …/canvas/tiles/:level/:x/:y`. They are drawn by `renderScene` (`#canvas/raster/scene.ts`), which already renders canvas regions for agents. The finest overview level is rendered from a view query of its tile (`minSize` = one tile pixel); each coarser tile is downsampled from its four children, so every element is drawn once per rebuild. A viewport's worth of tiles costs about the same at any zoom.

Tiles are cached as blobs under the document prefix, keyed by base. The working set marks finest-level tiles dirty from the old and new bbox of every record; a request for a dirty tile re-renders it and its ancestors, at most once per 10 s per tile. `CanvasFlushed` carries the union bbox of the flushed records, and a zoomed-out client re-requests the tiles in view that intersect it.

While zoomed out, the client holds no elements: hovering and clicking load the elements under the pointer with a `view` query, and selecting by marquee queries the server.

## Other consumers

- **Revisions**: the revision `snapshot` holds the manifest (base + segment keys), not JSON; taking one flushes the working set first, so it covers every broadcast op. Restore discards the pending buffer, writes a manifest with the revision's base and segments, starts a new epoch, rebuilds the segment map, and broadcasts `CanvasReload`. Clients drop their store, their docs, their undo stacks and every update kept for resending, then reload. Nothing is resent: the restore replaces the document, and edits built on the replaced state are discarded deliberately. GC keeps every blob a revision references.
- **Agent edits**: replace the JSON edit path in `#realtime/yjsRooms.ts` (`syncCanvasCollection`) with a load query, a Y.Doc per edited element on the server, and `CanvasOps` submitted by the server. Agent presence is unchanged.
- **Agent canvas API**: `document-canvas.ts` (describe, and operations applied to the parsed snapshot) and `document-canvas-render.ts` (PNG of a region) read the whole JSON snapshot through `canvasRequest`. Describe and render read a full or `view` load instead; operations go through the agent edit path.
- **Search, export, templates**: stream the full document through the decoder.
- **Cloudflare**: the blob store is R2 (range reads supported, multipart uploads for `putStream`), and the working set lives in the space's Durable Object.
  - Memory: all open canvases of a space share the object's 128 MB. A working set holds only the cached index, the segment map and pending records; a base rewrite holds about 60 bytes per element (6 MB at 100k). Working sets of canvases without room members are flushed and closed.
  - Compaction: there is no serializer worker, so it runs from the object's alarm, one document at a time. Both tiers are streaming and wait mostly on R2.
  - Eviction flushes, and hibernation is handled by the epoch in `CanvasOps` (see Durability).

## Tunables

Values marked *measured* come from the prototype (below); the others are still to be checked against a replay of a recorded editing session.

| Tunable | Value | Bounds |
|---|---|---|
| Flush delay | 1 s after the oldest pending record | edits lost on a crash from a client that is gone too |
| Flush size | 64 KB | the pending buffer |
| Segment merge | 4 adjacent segments within 2× in size | segments per open and per load |
| Base rewrite | segments > 25% of the base, ≥ 1 MB | write amplification: a base is rewritten at most once per quarter of its size in edits |
| GC age | 1 h | must exceed the longest write-to-commit gap of a flush or compaction |
| Range gap | 16 KB | *measured*: range reads per load against wasted bytes (4 ranges instead of 39, +15% bytes) |
| Overview zoom | 1/4 | *measured*: at 0.25 a viewport matches 2.7k elements (0.7 MB), at 0.125 already 9.3k (2.5 MB) |
| Region padding, eviction | 50%, 3× | requests while panning against client memory |
| Index node size | 16 | *measured*: 8, 16 and 32 read the same bytes; with the index cached, node size only affects build time |
| Point quantization | 16 × drawing zoom, power of two | *measured*: under 0.05 px at the drawing zoom |

## Prototype results

A prototype of the format (records, stroke points, Hilbert R-tree, base writer, range-read queries) and of per-element Y.Docs with the project's `yjs`, run on Bun. The board is 100k strokes recorded with the real `createFreehandRecorder` (random pen paths at 120 Hz, 22 points per stroke after simplification) in 200 clusters across 40k × 40k world units, plus 2k notes.

| | JSON snapshot today | `.vcanvas` base, Yjs per element |
|---|---|---|
| Size | 178 MB | 35 MB (20%); index 2.5 MB, ids 1.6 MB |
| Body per element | | note 176 B, stroke 190 B (57 B of it points) |
| Encode | 2.1 s (`JSON.stringify`) | 3.3 s to build the 102k docs (migration only) |

Viewport queries, 1920×1080 at the given zoom over a cluster, `minSize` = 1 px. Measured before the bodies became Yjs updates, which made records about 13% larger; element counts and ranges are unaffected.

| Zoom | Elements | Response | Ranges (exact / 16 KB gaps) |
|---|---|---|---|
| 2 | 290 | 0.1 MB | 39 / 4 |
| 1 | 712 | 0.2 MB | 26 / 4 |
| 0.25 | 2,705 | 0.7 MB | 35 / 4 |
| 0.05 | 46,795 | 12.5 MB | 128 / 17 |
| 0.01 | 80,924 | 22.7 MB | 16,674 / 1 |

Yjs per element:

| | |
|---|---|
| Concurrent move, resize and recolour, merged in different orders and with duplicates | converge to the same doc |
| `Y.mergeUpdates` on a stored element | 0.17 ms |
| History, 180 committed drags (two keys each) | 176 B → 5.1 KB merged, 1.9 KB re-encoded: about 5 B per overwritten value. Consecutive edits to one key compact fully (180 edits: 37 B) |
| History, 50 sessions of 21 edits each | 1.1 KB |
| Client memory | Y.Doc 8.2 KB, encoded state with decoded value 0.4 KB |

With gestures committing once, the history grows per gesture, not per pointer event.

## Removed

- The room-wide canvas Y.Doc: `seedCanvasDoc`, `withPinnedYjsSeed`, `parseCanvasContent` and `mapSnapshotFromDoc`. Element docs are created once (by the creating client, or at migration) and never re-seeded, so ids need no pinning.
- The `map-snapshot` format in `#documents/serialization.ts` and its rooms in `#realtime/yjsRooms.ts`.
- The 5 s persist throttle and large-payload brotli quality for canvases.
- The content spill path for canvases.

## Migration

One cutover. On first open (or a one-shot migration over all spaces), stream the JSON snapshot into a base file, building one element doc per shape and stroke, and write the manifest. Existing canvas revisions are converted the same way, each to its own base, and the pre-migration snapshot is kept as one more converted revision. No dual read path afterwards.

Strokes have no `z` today and render in `updatedAt` order (`syncStrokesFromY`). Migration assigns their `z` from that order, and connectors get `refs` from their endpoints.

## Module layout

Following the canvas layering (`geometry → render/input → document → …`), the format lives in `#canvas/document/format/` and is imported by both client and server:

- `records.ts`: varints, record encode/decode, stroke points.
- `hilbert.ts`, `rtree.ts`: index build and query.
- `lookup.ts`: the `ids` and `refs` tables.
- `stream.ts`: incremental decoder over a `ReadableStream<Uint8Array>`.
- `element.ts`: element docs: creating, decoding, summaries.

The server side (manifest, flush, compaction, query) lives in `#db/space/canvasStore.ts`, and the room in `#realtime/canvasRooms.ts`.

## Testing

Integration level only:

- Round-trip a real canvas through migration → load → edit → compaction → load and compare rendered snapshots.
- The walkthrough above, scripted with three browser clients, asserting the final docs and summaries.
- Two browser clients editing different keys, and the same key, of one shape concurrently; both converge as with Yjs today.
- Panning while another client moves and deletes elements across the edge of the requested region: no element comes back in its old state.
- Moving a shape whose connector's other end is off-view: the connector is loaded with the shape and its bbox follows.
- A server restart between broadcast and flush: connected clients see a new epoch, reload, resend, and their unflushed edits land.
- A revision restore while another client is editing: the client reloads the restored state, and its next edit lands.
- Deleting a shape, undoing after a base rewrite dropped it: the shape comes back with its state.
- Loading zoomed out, then zooming in over the same region: the small elements arrive, the large ones are not fetched twice.
- A viewport load that asserts only intersecting ids arrive.
- A large generated board (100k strokes) that checks load time and server memory against today.
- Zooming that board out to fit: the client switches to overview tiles, and a stroke drawn elsewhere appears in them after the next flush.
- A stroke drawn at 16× zoom, reloaded: its rendered snapshot matches the original at that zoom.

## Open questions

- Element docs keep their history until a base rewrite and keep about 5 B per overwritten value after it. Re-seeding an element would discard it but change its item ids, which breaks clients holding the old doc. Whether any element grows enough in practice to need it.
- How long rendering the finest overview level takes for the 100k board with `renderScene`, and whether tile rebuilds belong in the serializer worker.
- How existing strokes are quantized at migration: their drawing zoom was not stored, so either a fine fixed scale (64) or one derived from their point spacing.
- Whether a base rewrite of the largest boards fits one Durable Object alarm invocation, or needs to resume across several.
- Whether the region loader should send its loaded rects so the server can subtract them, instead of the client computing uncovered areas.
