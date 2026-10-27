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
- The server never holds a whole canvas in memory, including during compaction. The one-time migration is the only exception (see Migration).
- No new SQLite tables. The canvas lives in the blob store; the document row only points at it.
- One sync implementation: Yjs merges, as it does for every other document type.

## Non-goals

- Partial loading for the other Yjs-backed document types. Rich text stays on one Y.Doc per document.
- Offline editing. Yjs would merge offline edits, but resending them after a long disconnect is not designed here.

## Elements as Y.Docs

Every element (shape or stroke) is one Y.Doc whose root map `e` holds everything the client renders: `type`, `z`, `updatedAt`, `authorId`, `locked`, `deleted`, the map `refs` (see Summary), and for shapes the nested maps `frame`, `style`, `data`, for strokes `style`, `rotation`, `kind` and `points`. The keys and nesting are those of the maps in `canvas.shapes` and `canvas.strokes` today, so merge behavior does not change: concurrent edits to different keys both land, the same key resolves last-writer-wins.

Clocks are per element, so any element can be loaded alone. A session uses one random `clientID` for every element doc it edits.

Yjs continues a client's clock from the state it holds for that `clientID`. A client that drops an element and loads it again before the server has its edits would reuse clocks it already used for different content, and the docs would diverge without an error. Three rules prevent it: a client never drops an element whose updates from this session are not yet covered by a `CanvasFlushed` (see Client), a reload merges into the elements it holds and never replaces them (see Durability), and it takes a new `clientID` whenever it drops its whole store (see Other consumers).

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

Summaries are last-writer-wins in server order, while docs merge. After two concurrent edits that both change an element's extent (one moves, one resizes), the merged doc can disagree with the last summary. A summary is **stale** when its bbox does not contain the bbox computed from the doc, or its `refs` or `deleted` differ. For an element with `refs`, the bbox is computed from its doc and the docs of the elements it references, as rendering resolves it: a connector's summary goes stale when either endpoint moves, though its own doc did not change; a summary that is merely larger is conservative and costs only extra loads.

Two writers repair stale summaries, without any client watching another's:

- **The sender, on its echo.** When a client receives the echo of its own record, it has merged every record ordered before it, so its doc is the element's state at that `seq`. If its summary is stale against that doc (and, for a connector, its endpoints' docs, which the client holds; see Loading), it sends a correction: a record with the new summary and an empty update. Only the sender of a record checks it, so one stale summary gets one correction. A correction is a record too, and its sender checks its echo the same way, so corrections stop once no concurrent edit lands between a record and its echo.

  A move and the summaries it causes for connectors go in one `CanvasOps` frame, so they get consecutive `seq`s. When P moves A and Q moves B, both sending a summary for their connector C, whichever frame comes second carries the stale summary of C, and its sender has merged the other move by its echo and corrects it.
- **The server, at a base rewrite.** It decodes every changed element anyway (see Compaction), and computes its bounds with the geometry the agent renderer already uses (`shapeBounds` in `#canvas/agent/model.ts`: rotation, text measured with the server's fonts, connector routes; stroke point bounds). Where the stored bbox does not contain them, it stores the union. It stores `refs` from the doc's `refs` map, and drops the element if the doc has `deleted` set (see Deletion), so the rewrite repairs every part of a stale summary. Connectors that reference a changed element count as changed, transitively, and a connector's route needs its endpoints: the rewrite also decodes the elements a changed connector's `refs` name, unchanged ones included, only to resolve the route (see Compaction). This covers a sender that disconnected before its echo; until the rewrite, a stale `refs` or `deleted` stays in the index, and a stale bbox may cull the element at the edge of a view; widening never removes a correct region, so server and client geometry need not agree exactly.

`bbox` is computed by the client, because only it can lay out text. It is rounded outward when narrowed to f32 (min towards −∞, max towards +∞): f32 resolution is about 0.1 world units far from the origin, and rounding to nearest would cull elements at the viewport edge. The server only asserts it is finite and ordered.

`refs` lists the elements this one is derived from: a connector's endpoints, which may be connectors themselves. The endpoints live in the type's extension-defined `data`, whose layout the server does not know, so the type also writes them to the doc's `refs` map, keyed by role (`start`, `end`), in the same transaction as the `data` change. Concurrent changes to different endpoints both land, and concurrent changes to the same endpoint resolve to the same writer in both maps, since Yjs orders concurrent sets by `clientID`. The summary's `refs` are the map's values, so the server reads them from the doc at a base rewrite without knowing the type. Loads use it in both directions (see Loading): a client holding an element also holds the elements that reference it, and a client holding a connector also holds its endpoints, so it can compute the connector's bbox. A ref may dangle: an element whose endpoint was deleted keeps its `refs`, and its type's `resolve` already handles a lookup that finds nothing.

### Deletion

Deleting sets `deleted` in the element's doc, so a delete merges like any edit and `Y.UndoManager` undoes it. The summary flag mirrors it for the server: deleted elements are left out of loads. A base rewrite drops an element only when its merged doc has `deleted` set, never on the summary flag alone, because a stale summary would otherwise drop a live element for good. Undoing a delete after that sends the element's full state (summary flag `full`), which the client still holds through its undo stack; the server drops records without `full` for ids it no longer has, so stale updates to a long-deleted element vanish.

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

A packed Hilbert R-tree, as in FlatGeobuf. Elements in a base are sorted by the Hilbert value of their bbox centre, computed on a fixed grid of one-world-unit cells centred on the origin (2³² per axis, a u64 value, clamped at the edges), not on the document bounds, so an element's value depends only on its own bbox and stays the same across rewrites. The order also makes elements close on the canvas close in the file. The tree is stored root-first; node size is 16. Each node entry is 4×f32 bbox plus a u64 offset: a child node index for internal entries, the file offset of the `element` record for leaves (≈ 24 bytes per element).

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
- `merged-<uuid>.vcanvas` — the result of a segment merge, in the same list and order. A name from its seq range would collide: a higher-tier merge ends at the same `seq` as its last input, and would overwrite a blob a revision or an open read may still reference.
- `fold-<uuid>.vcanvas` — a base rewrite's re-encoded elements (see Compaction), never in a manifest; garbage once the rewrite ends.

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

The server keeps one working set per open canvas: its `epoch`, the `seq` counter, the records not yet flushed, the **segment map** `id → (summary, record locations)` for every element with records in the listed segments or the pending buffer, and its reverse `ref → ids`, both stored as columns (see Memory). Opening a canvas builds the map by streaming the segments once. The map is bounded by compaction and holds no payloads; the server never holds elements.

1. A client sends a `CanvasOps` frame: the `epoch` it holds, an `opId`, and `element` records.
2. The server checks write access and readonly, answers a frame from another epoch with `CanvasJoined` instead (see Durability), and checks each summary for well-formedness and size limits. It drops records without `full` for ids that exist in neither the map nor the base.
3. Each record gets the next `seq`, updates the segment map, is appended to the pending buffer, and the frame is broadcast to the room, the sender included, carrying its `opId`.
4. A flush (1 s after the oldest pending record, 64 KB pending, the last client leaving, server shutdown, or the working set being evicted) writes the pending records as `seg-<firstSeq>-<epoch>.vcanvas`, updates the manifest (`seq`, `segments`, `bounds`), and then broadcasts `CanvasFlushed` with the flushed `seq`.

Nothing is rejected and the server never reads an update: merging happens where the doc is needed.

**Gestures commit once.** A drag, resize or rotate writes the element docs when the pointer is released, as strokes already do (`strokePreview`). A drag is one record per element, which also keeps each doc's history small (see Prototype results). An interrupted gesture commits nothing.

Others see the gesture live through presence. `CanvasPresenceState` (`#editor/collaboration.ts`) gains `gesture: { transform: [a, b, c, d, e, f] } | null`, the affine transform of the gesture so far, applied to the sender's `selectionIds`, which presence already carries. The gesture code is split into "pointer → transform" and "transform → preview geometry", and receivers run the second half on the elements they hold, so a remote preview is drawn exactly as the local one. It rides the existing presence updates, one per animation frame. The sender clears `gesture` only after the echo of its commit arrives; the echo reaches every client at the same broadcast, so receivers apply the committed records before the preview disappears, and the elements never jump back.

### Durability

Clients see ops at broadcast, before they are durable. Every client keeps a **resend set**: the held elements it sent or applied a record for that no `CanvasFlushed` covers yet, its own records counting from the moment it sends them. An element leaves the set once a `CanvasFlushed` covers the `seq` of its last record and no record of its own is still waiting for its echo.

A graceful shutdown or eviction flushes first. A crash loses the unflushed records, and the next open starts a new working set with a new `epoch`, continuing from the manifest's `seq`. The client cannot rely on its socket dropping to notice (a hibernated Durable Object keeps its sockets while its memory is gone), so every `CanvasOps` frame carries the epoch, and a frame from an old epoch is answered with `CanvasJoined` for the new one. On an epoch change, the client:

1. Reloads its region, merging each response record into the element it holds instead of replacing it. Its state keeps every clock the client used, so its next edit continues past them.
2. Sends one `full` record per element in its resend set: the element's whole state, with the summary computed from it. Corrections follow from the echoes as for any record (see Summary).

Resending the whole state, not just the client's own updates, matters because an update can depend on another client's record. An update that overwrites a key carries the overwritten item as its origin. If Q's recolour is lost in the crash and Q is gone, P's later recolour of the same element would stay pending on every other client. P merged Q's record, so P's whole state carries it.

State the server already had merges as a no-op. Nothing a connected client wrote or applied is lost. Records that only a departed client held are lost, at most one flush interval, and no surviving update depends on them, because building on a record requires holding it.

### Compaction

Compaction has two tiers, so its cost follows the edits, not the document. Both run in the serializer worker, one at a time per document, and hand their result to the working set, which commits it conditional on the manifest's base being unchanged (a restore during compaction discards the result).

**Segment merge**, size-tiered: whenever 4 adjacent segments are within 2× of each other in size, they are merged into a new `merged-<uuid>.vcanvas`: one record per id, with the latest summary and the updates combined by `Y.mergeUpdates`, which works on the encoded updates without loading a doc. A record is rewritten once per tier, the segment count stays logarithmic in the segments' total size, and no merge rewrites a large merged segment for a few small ones.

**Base rewrite**, when segments exceed 25% of the base's size (and at least 1 MB). It covers the segments present when it starts. Every blob is read sequentially or in coalesced ranges, never one range per element:

1. Build the element table (see Memory) from the base's `index`, `ids` and `refs`, without reading its elements: an unchanged record's length is the distance to the next record offset. Then stream the segments for the changed elements' latest summaries and record locations. Add the connectors that reference a changed element, through the base's `refs` table and the segment map's reverse refs, with a visited set: they have no new records, but their routes may have moved.
2. Sort the changed ids by the Hilbert value of their latest summary's bbox.
3. **Fold** the changed elements, in that order, into a temporary `fold-<uuid>.vcanvas` written through `putStream`, in chunks of up to 8 MB of input records. A chunk first reads its records from the base and from each segment as ranges sorted by offset, coalescing gaps under 16 KB, as loads do. Then, for each element, it loads the base state and updates into a Y.Doc and re-encodes it, which garbage-collects overwritten values (a dragged shape: 5.1 KB of merged updates, 1.9 KB re-encoded), and appends the record to the fold. Before computing the bounds of the chunk's connectors, it resolves their endpoints: the elements named in each decoded `refs` map, and theirs in turn, as rendering resolves them, that are not in the chunk. They are read in one more round of coalesced ranges per hop, from the base and, for changed ones, the segments, and decoded for their geometry only; nothing is written for them and their docs are discarded with the chunk. An element whose doc has `deleted` set is dropped; the summaries' `deleted` flag is not consulted. The table keeps the record's length, its fold offset, the widened bbox and the doc's `refs` (see Summary). Other unchanged elements are not decoded: the base holds no deleted elements, so they are all live.
4. Order the live elements by Hilbert value: unchanged ones by their bbox, changed ones by the key from step 2, so the fold is already in output order. A bbox widened in step 3 goes into the index without moving its element; the order is only for locality, and the index stays exact.
5. Build `index`, `ids` and `refs` from the record lengths, and stream the output through `putStream`: header, index, ids, refs, then the elements, merged from two sequential reads: the old base for the unchanged elements, which are in the same order there because their Hilbert values did not change, and the fold for the changed ones. Each element is encoded once.
6. Update the manifest to the new base plus the segments flushed since it started, with exact `bounds`. Drop the map entries it folded. The fold is garbage from then on (see Storage).

With 10 MB of segments on a 40 MB base, a rewrite reads each segment about twice (two chunks), the base once in full and once in the ranges of the changed elements, and the fold once.

Clients are not told: their docs already hold everything the new base holds.

### Memory

The segment map, its reverse refs and the rewrite's element table are typed-array columns indexed by element number, not JS objects: a `Map` entry holding an id string, a bbox object and arrays costs 150–300 bytes. Per element:

| Column | Bytes |
|---|---|
| id: offset u32 and length u8 into one UTF-8 arena | 41 for a UUID |
| hash table slot: element number u32, load ≤ 2/3; a lookup compares the id in the arena | 6 |
| bbox, 4×f32 | 16 |
| Hilbert value, u64 | 8 |
| base offset f64, fold offset u32, record length u32 | 16 |
| first record location u32, first ref u32 | 8 |

Record locations and refs are linked lists in shared pools: 16 bytes per location (segment, offset, length, next) and 12 per ref (the referenced id's hash u64, next u32; a ref may dangle, so it names no element number). That is about 100 bytes per element: a base rewrite at 100k holds 10 MB of table, one 8 MB fold chunk and one Y.Doc at a time. The working set holds the same columns for the elements in its segments only, which compaction bounds, plus the base's `index` and `ids` as the bytes read (40 bytes per element, 4 MB at 100k).

## Loading

`GET /api/v1/spaces/:space/documents/:id/canvas` returns `application/vnd.vektor.canvas`:

| Query | Returns |
|---|---|
| `view=x0,y0,x1,y1` | elements whose bbox intersects the rect |
| `minSize=s` | additionally skips elements whose bbox is smaller than `s` world units in both axes |
| `maxSize=m` | additionally skips elements whose bbox is at least `m` world units in either axis |
| `ids=a,b,…` | the named elements, via the `ids` table; combined with `view`, the union |
| none | every element (export, agent, search indexing) |

Matching uses the latest summary: the map's for elements with segment records, the base's otherwise. Deleted elements are skipped. Every response closes the matches over `refs` in two steps:

1. **Referencing**, transitively: the elements that reference a returned element, via the `refs` table and the map's reverse refs, with a visited set. A client holding a shape holds the connectors attached to it, and the connectors attached to those.
2. **Referenced**, one hop: the elements named in the `refs` of every element returned so far, via the `ids` table. A client holding a connector holds both its endpoints, which it needs to compute the connector's bbox when one of them moves. These are not closed again: following referencing elements from an endpoint would pull in every connected diagram.

An endpoint reached in step 2 can itself be a connector whose endpoints were not returned. The client renders it as loaded, and fetches its endpoints with `ids=` before it has to compute its bbox.

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
| 20 | `CanvasFlushed` | server → client | JSON `{ seq, bounds }` |
| 21 | `CanvasReload` | server → client | JSON `{ epoch, seq }` — after a revision restore |

Records are the file's records, `kind | length | payload`, so a client decodes live ops and load responses with the same decoder.

Every op goes to every room member, on one ordered socket per client. A client applies every record for an element it holds. A record for an element it does not hold, whose `refs` name an element it holds or whose bbox intersects the loaded region, brings that element in:

- With `full`, the record is the element's whole state, and the client adds it.
- Without `full`, the update depends on state the client never loaded, and Yjs would hold it back as pending. The client keeps the record, requests the element with `ids=`, and merges the kept records into it when the response delivers it, exactly as during a region load (see Join order). A shape moved into the region by another client arrives this way.

The client keeps the remaining records while requests are outstanding (see Join order). The client keeps no summaries: for an element it holds, it computes bbox, `refs` and `deleted` from the element's state, as the op writer does, so a response that read the segment map after its `cursor` cannot leave an older summary behind. A record's summary is read only to decide whether it brings an element in. Presence entries live in the canvas room, as they live in the Yjs room today (`yRooms` in `#realtime/presence.ts`), so removing the canvas Yjs rooms keeps presence and its gesture previews.

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
| 7 | Q resizes A at the same moment as P moves it again | P's record is 104, Q's 105; the last summary is Q's, with A's old position | everyone merges position and size. P's echo (104) comes before 105, so P's summary matches its doc. Q's echo (105) comes after 104: Q's summary misses P's move, and Q sends the correction, 106 |
| 8 | Flush | `seg-101-E.vcanvas`, `CanvasFlushed` 106 | clients clear their resend sets up to 106 |

Every client ends with the same doc for A, and the index with A's true bbox.

## Client

The canvas controller replaces the room-wide Y.Doc and its `observeDeep` sync (`#canvas/runtime/controller.ts`) with:

- **Element store**: for each held element, its encoded state and its decoded value. Incoming records are merged with `Y.mergeUpdates` and decoded through a short-lived Y.Doc (3000 elements in 44 ms). A Y.Doc costs about 8 KB in memory against 0.4 KB for bytes and value, so a doc is kept only for elements being edited or in the undo stack.
- **Streaming decoder**: merges elements into the store as records arrive and requests a render per batch.
- **Region loader**: on viewport change, it requests the viewport padded by 50%, and passes `minSize` = one screen pixel in world units. The loader records each loaded rect with the `minSize` it was loaded at. A request covers only what no loaded rect covers at that `minSize` or finer; where a rect was loaded coarser (the user zoomed in), it requests that area with `maxSize` = the old `minSize`, fetching just the elements the coarser load skipped. Elements beyond 3× the viewport are evicted unless selected, being edited, in the undo stack, or holding updates from this session not yet covered by a `CanvasFlushed` (see Elements as Y.Docs), and evicting them shrinks the loaded rects to match.
- **Op writer**: sends each local transaction's update with the summary computed from the doc. Editing a shape also sends summary-only records for the connectors that reference it, so their bboxes stay true; the client holds them and their other endpoints, because every load returns referencing elements and the endpoints of what it returns.
- **Undo**: a `Y.UndoManager` per element doc, tracking local origins, under an app-level stack that groups the elements one user action touched; undoing pops a group and undoes each. Remote edits to other keys survive, as today.

The client never assumes it holds every element:

- **Fit to content, minimap**: use the manifest's `bounds`, sent in `CanvasJoined` and updated with each `CanvasFlushed`.
- **Select all, search**: query the server.
- **Moving a section**: loads the section's bbox first, so contained elements are present.
- **Connectors**: arrive with their endpoints (see Loading); only a connector reached as an endpoint loads its own endpoints with `ids=`, when it is edited.

## Zooming out

There is no level of detail beyond size culling: the client's zoom stops at 0.15 (`minZoom` in `#canvas/runtime/controller.ts`), and fit to content at 0.25. On the 100k-stroke prototype board, a 1920×1080 viewport at 0.25 holds 2,705 elements (0.95 MB); at 0.15 it holds about 2.8× as many, 7.5k elements (2.7 MB). Zooming out further would need one, because the element count, not the bytes per element, is the cost.

## Other consumers

- **Revisions**: the revision `snapshot` holds the manifest (base + segment keys), not JSON; taking one flushes the working set first, so it covers every broadcast op. Restore discards the pending buffer, writes a manifest with the revision's base and segments, starts a new epoch, rebuilds the segment map, and broadcasts `CanvasReload`. Clients drop their store, their docs, their undo stacks and their resend sets, take a new `clientID`, then reload. The restored state can lack updates the old `clientID` already made, so continuing with it would reuse clocks. Nothing is resent: the restore replaces the document, and edits built on the replaced state are discarded deliberately. GC keeps every blob a revision references.
- **Agent edits**: replace the JSON edit path in `#realtime/yjsRooms.ts` (`syncCanvasCollection`) with a load query, a Y.Doc per edited element on the server, and `CanvasOps` submitted by the server. Agent presence is unchanged.
- **Agent canvas API**: `document-canvas.ts` (describe, and operations applied to the parsed snapshot) and `document-canvas-render.ts` (PNG of a region) read the whole JSON snapshot through `canvasRequest`. Describe and render read a full or `view` load instead; operations go through the agent edit path.
- **Search, export, templates**: stream the full document through the decoder.
- **Cloudflare**: the blob store is R2 (range reads supported, multipart uploads for `putStream`), and the working set lives in the space's Durable Object.
  - Memory: all open canvases of a space share the object's 128 MB. A working set holds only the cached index, the segment map and pending records; a base rewrite holds its element table and one fold chunk (18 MB at 100k, see Memory). Working sets of canvases without room members are flushed and closed.
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
| Fold chunk | 8 MB of input records | rewrite memory against passes over the segments |
| GC age | 1 h | must exceed the longest write-to-commit gap of a flush or compaction |
| Range gap | 16 KB | *measured*: range reads per load against wasted bytes (4 ranges instead of 39, +15% bytes) |
| Region padding, eviction | 50%, 3× | requests while panning against client memory |
| Index node size | 16 | *measured*: 8, 16 and 32 read the same bytes; with the index cached, node size only affects build time |
| Point quantization | 16 × drawing zoom, power of two | *measured*: under 0.05 px at the drawing zoom |

## Prototype results

A prototype of the format (records, stroke points, Hilbert R-tree, base writer, range-read queries) and of per-element Y.Docs with the project's `yjs`, run on Bun. The board is 100k strokes recorded with the real `createFreehandRecorder` (random pen paths at 120 Hz, 22 points per stroke after simplification) in 200 clusters across 40k × 40k world units, plus 2k notes.

| | JSON snapshot today | `.vcanvas` base, Yjs per element |
|---|---|---|
| Size | 178 MB | 39.6 MB (22%); index 2.5 MB, ids 1.6 MB |
| Update per element | | note 176 B, stroke 190 B (57 B of it points), before `type`, `z`, `updatedAt` and `authorId` |
| Encode | 2.1 s (`JSON.stringify`) | 3.3 s to build the 102k docs (migration only) |

Viewport queries, 1920×1080 at the given zoom over a cluster, `minSize` = 1 px:

| Zoom | Elements | Response | Ranges (exact / 16 KB gaps) |
|---|---|---|---|
| 2 | 290 | 0.10 MB | 39 / 4 |
| 1 | 712 | 0.25 MB | 26 / 4 |
| 0.25 | 2,705 | 0.95 MB | 35 / 7 |

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

One cutover. On first open (or a one-shot migration over all spaces), convert the JSON snapshot into a base file and write the manifest. This is the one point where the server holds a whole canvas: it parses the snapshot as every load does today, so a canvas that opens today migrates.

The conversion runs in the serializer worker, in the same two passes as a base rewrite. The first pass builds one element doc per shape and stroke, keeps its id, bbox, refs and encoded length, and discards the doc. The second, after the Hilbert sort, writes header, index, ids and refs, then builds each doc again and streams its record. Peak memory is the parsed snapshot plus the element table (about 100 bytes per element, see Memory); neither the docs nor the 40 MB base are held. Existing canvas revisions are converted the same way, each to its own base, and the pre-migration snapshot is kept as one more converted revision. No dual read path afterwards.

Strokes have no `z` today and render in `updatedAt` order (`syncStrokesFromY`). Migration assigns their `z` from that order, and connectors get their `refs` map from their endpoints.

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
- Another client moving a shape from off-view into the loaded region: the shape appears at its new position with its full state.
- Moving a shape whose connector's other end is off-view: the connector is loaded with the shape and its bbox follows.
- A server restart between broadcast and flush: connected clients see a new epoch, reload, resend, and their unflushed edits land.
- Q recolours a shape and disconnects, P recolours it again, and the server restarts before the flush: after the resend, a client loading the shape gets P's colour.
- A revision restore while another client is editing: the client reloads the restored state, and its next edit lands.
- Deleting a shape, undoing after a base rewrite dropped it: the shape comes back with its state.
- A base rewrite over a shape whose last summary says `deleted` while its merged doc does not: the shape survives the rewrite.
- Loading zoomed out, then zooming in over the same region: the small elements arrive, the large ones are not fetched twice.
- A viewport load that asserts only intersecting ids arrive.
- A large generated board (100k strokes) that checks load time and server memory against today.
- Zooming that board out to the minimum zoom over its densest area: the response stays under 3 MB.
- A base rewrite and a migration of the 100k board, asserting the server's peak memory stays within the bounds above.
- A drag watched by a second client: the preview follows the transform, and the committed position replaces it without a jump back.
- A move and a concurrent resize of one shape: exactly one correction is written, and a `view` query at the merged position returns the shape.
- Two clients moving the two endpoints of one connector concurrently: one correction is written, and a `view` query over the connector's merged route returns it.
- Two clients reattaching the two ends of one connector to different shapes concurrently, the later one disconnected before its echo: after the next base rewrite, loading either new endpoint returns the connector.
- A client that edits a shape, pans until the shape would be evicted before the next flush, pans back and edits it again: every client converges to the same doc.
- The same with the resizing client disconnected before its echo: after the next base rewrite, a `view` query at the merged position returns the shape.
- A stroke drawn at 16× zoom, reloaded: its rendered snapshot matches the original at that zoom.

## Open questions

- Element docs keep their history until a base rewrite and keep about 5 B per overwritten value after it. Re-seeding an element would discard it but change its item ids, which breaks clients holding the old doc. Whether any element grows enough in practice to need it.
- How existing strokes are quantized at migration: their drawing zoom was not stored, so either a fine fixed scale (64) or one derived from their point spacing.
- Whether a base rewrite of the largest boards fits one Durable Object alarm invocation, or needs to resume across several; fold chunks are the natural point to resume from.
- Whether the region loader should send its loaded rects so the server can subtract them, instead of the client computing uncovered areas.
