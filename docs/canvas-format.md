# Canvas format

Documents become sets of **objects**. An object has an id, **properties** merged per key, last writer wins, and optionally a **body**: a Y.Doc holding rich text. Objects carry no causal history across each other, so any subset of them loads on its own.

A canvas is many objects, one per shape or stroke, stored in a single binary wire format (`.vcanvas`) that is at once the stored file, the HTTP response and the live-op frame. It streams front to back, and a spatial index lets a reader fetch only the objects in view. Text in shapes is a body, so it merges character by character. A rich-text document is one object whose body is the document (see Rich-text documents).

## Where we are

- A canvas is persisted as one JSON snapshot `{ version: 1, shapes, strokes }` in `document.content`, spilled to the blob store above 1 MB (`#db/space/documentContent.ts`).
- Live editing runs through a Yjs room over one Y.Doc per canvas. Every persist re-serializes the whole doc (`contentFromDoc` → `JSON.stringify`, throttled to 5 s because it stalls the event loop), and every load re-seeds a Y.Doc from JSON with pinned ids (`seedCanvasDoc`, `withPinnedYjsSeed`).
- Revisions brotli the full JSON (`#db/space/revisions.ts`), with quality dropped for large canvases.
- Strokes store points as `{ x, y, width }` objects. Images are already references.
- The canvas only uses Yjs as nested last-writer-wins maps (`canvas.shapes`, `canvas.strokes`): no `Y.Text`, `Y.Array` or `XmlFragment`.
- Shape text is a string in `data.text`, which the rich-text editor replaces as a whole on every change (`#canvas/runtime/elementBase.ts`). Two users typing in one shape overwrite each other.

Nothing can be loaded partially: a client needs the entire document before it renders anything, and the server needs it in memory to save. One Y.Doc cannot be loaded partially either: its item ids are `(clientID, clock)` with one clock per client across all elements, so an update to one element can depend on structs in elements the client never loaded, and Yjs holds it back as pending.

## Goals

- Load streams: the first objects render before the last byte arrives.
- Load is spatial: a client fetches the objects intersecting its viewport, and more as it pans.
- Saving costs the size of the edit, not the size of the document.
- The server never holds a whole canvas in memory on the storage and sync path, including during compaction. The one-time migration is the only exception (see Migration).
- No new SQLite tables. The canvas lives in the blob store; the document row only points at it.
- Text in canvas shapes is edited collaboratively, as in rich-text documents.
- One object model for every document type: properties merge last-writer-wins, rich text merges through Yjs.

## Non-goals

- Partial loading inside one body. A rich-text document loads whole, as today.
- Moving rich-text documents onto the object store. The format allows it (see Rich-text documents); this spec migrates canvases.
- Offline editing. Objects would merge offline edits, but resending them after a long disconnect is not designed here.
- Live previews of other users' gestures. Others see a drag, resize or rotate when it commits.

## Objects

An object is a shape or a stroke. Its properties are the keys of the maps in `canvas.shapes` and `canvas.strokes` today, flattened to dotted paths: `type`, `z`, `updatedAt`, `authorId`, `locked`, `deleted`, `frame.x`, `frame.width`, `style.<key>`, `data.<key>`, `refs.<role>` (see Summary), and for strokes `rotation`, `kind` and `points`. A value that is a plain object today (inside `data`) stays one value. Merge behavior does not change: concurrent edits to different keys both land, the same key resolves to one writer.

### Properties

Every write carries a timestamp `(counter, writer)`. `writer` is a random u64 per session. `counter` is a Lamport clock: a session keeps one counter for all objects, and a write takes `max(session counter, highest counter in the object) + 1` and stores it back. For each key the write with the highest timestamp wins, `counter` first, then `writer`.

So a write always beats every value its writer had seen, and concurrent writes resolve the same way everywhere. Merging is per key and needs nothing else: writes apply in any order, applying one twice is harmless, and no write depends on another. A session's counter only grows, so it never issues one timestamp twice, whatever it drops and reloads.

Writes of one transaction share a timestamp and travel in one record. Setting a key to `null` removes it.

`points` is a bytes value:

```
count varint
x0 y0 zigzag varint, w0 varint    // absolute, in 1/64 world units
(dx dy zigzag varint, dw zigzag varint) × (count − 1)
```

Points are quantized to 1/64 world unit, and each delta is taken between quantized points, so errors do not add up. The error stays under 0.08 CSS pixels per axis at the maximum zoom of 10 (`maxZoom` in `#canvas/runtime/controller.ts`).

### Bodies

A type that holds rich text declares a body: text, notes and geo labels today. The body is a Y.Doc whose `XmlFragment` `text` the canvas's rich-text editor binds to through the existing `Collaboration` extension and its `fragment` option (`#editor/extensions/Collaboration.ts`), as documents bind theirs. `data.text` goes away.

A body's updates travel in the object's records next to its property writes. Yjs merges them in any order and ignores duplicates, as for properties. Yjs updates do depend on each other: an update can name items from earlier updates as its origin. Bodies are small, and a client always loads an object with its whole body, so this never blocks a load (see Durability for the one place it matters).

A client takes a fresh Yjs `clientID` every time it instantiates a body doc. Yjs continues a client's clock from the state the doc holds for that `clientID`, so a doc rebuilt from state that lacks some of its own updates would reuse clocks for different content. A fresh `clientID` cannot collide; it costs a few bytes of state vector per editing session.

The renderer reads the body through its decoded value, the text model `drawTextLayout` (`#canvas/render/text.ts`) draws, kept next to the encoded state (see Client).

### Summary

The server indexes objects without reading their properties. Every record therefore carries a **summary**: the object's `bbox`, its `refs` and whether it is deleted, computed by the client from the object's state. The state is the truth and the summary a cache of it for the index.

Summaries are last-writer-wins in server order, while properties merge by timestamp. After two concurrent edits that both change an object's extent (one moves, one resizes), the merged state can disagree with the last summary. A summary is **stale** when its bbox does not contain the bbox computed from the state, or its `refs` or `deleted` differ. For an object with `refs`, the bbox is computed from its state and the state of the objects it references, as rendering resolves it: a connector's summary goes stale when either endpoint moves, though the connector did not change; a summary that is merely larger is conservative and costs only extra loads.

Two writers repair stale summaries, without any client watching another's:

- **The sender, on its echo.** When a client receives the echo of its own record, it has merged every record ordered before it. If it has no later record of its own for that object still waiting for its echo, its state is the object's state at that `seq`. If the summary is stale against that state (and, for a connector, its endpoints' state, which the client holds; see Loading), it sends a correction: a record with the new summary and no writes. Only the sender of a record checks it, so one stale summary gets one correction. A correction is a record too, and its sender checks its echo the same way, so corrections stop once no concurrent edit lands between a record and its echo.

  A move and the summaries it causes for connectors go in one `CanvasOps` frame, so they get consecutive `seq`s. When P moves A and Q moves B, both sending a summary for their connector C, whichever frame comes second carries the stale summary of C, and its sender has merged the other move by its echo and corrects it.
- **The server, at a base rewrite.** It merges every changed object's properties anyway (see Compaction), and computes its bounds with the geometry the agent renderer already uses (`shapeBounds` in `#canvas/agent/model.ts`: the rotated frame, connector routes through `resolveLine`; stroke point bounds). It does not lay out text, so text overflowing its frame keeps the client's bbox. Where the stored bbox does not contain them, it stores the union. It stores `refs` from the `refs.*` properties, and drops the object if `deleted` is set (see Deletion), so the rewrite repairs every part of a stale summary. Connectors that reference a changed object count as changed, transitively, and a connector's route needs its endpoints: the rewrite also reads the objects a changed connector's `refs` name, unchanged ones included, only to resolve the route. This covers a sender that disconnected before its echo; until the rewrite, a stale `refs` or `deleted` stays in the index, and a stale bbox may cull the object at the edge of a view; widening never removes a correct region, so server and client geometry need not agree exactly.

`bbox` is computed by the client, because only it can lay out text. It is rounded outward when narrowed to f32 (min towards −∞, max towards +∞): f32 resolution is about 0.1 world units far from the origin, and rounding to nearest would cull objects at the viewport edge. The server only asserts it is finite and ordered.

A client with write access that renders an object whose laid-out extent the summary bbox does not contain sends a correction, as on an echo. This repairs the bboxes migration computed without text layout (see Migration); corrections from concurrent viewers are identical and harmless.

`refs` lists the objects this one is derived from: a connector's endpoints, which may be connectors themselves. The endpoints live in the type's extension-defined `data`, so the type also writes them to `refs.<role>` (`refs.start`, `refs.end`) in the same transaction as the `data` change; one timestamp covers both, so they resolve to the same writer. The summary's `refs` are those values, so the server reads them at a base rewrite without knowing the type. Loads use them in both directions (see Loading): a client holding an object also holds the objects that reference it, and a client holding a connector also holds its endpoints, so it can compute the connector's bbox. A ref may dangle: an object whose endpoint was deleted keeps its `refs`, and its type's `resolve` already handles a lookup that finds nothing.

### Deletion

Deleting writes `deleted: true`, so a delete merges like any edit. The summary flag mirrors it for the server: deleted objects are left out of `view` loads. A base rewrite drops an object only when its merged properties have `deleted` set, never on the summary flag alone, because a stale summary would otherwise drop a live object for good.

Undoing a delete writes `deleted: false` and sends the object's full state (summary flag `full`), which the client still holds through its undo stack: the client cannot know whether a base rewrite has dropped the object since. The server drops records without `full` for ids it no longer has, so stale writes to a long-deleted object vanish.

Undoing a create writes `deleted: true`; redoing it writes `deleted: false`.

## File layout

```
magic "VCNV" (4 bytes) | version u8
record*
record = kind u8 | length varint | payload[length]
```

All varints are unsigned LEB128; signed integers are zigzag-encoded. Floats are little-endian. Every record decodes without reading anything after it, so a reader processes records as they arrive and skips unknown kinds by `length`.

A file is the log of everything written to it: for any object id, the summary of the record with the highest `seq` wins, and all its writes and body updates merge.

### Record kinds

| Kind | Name | Where | Payload |
|---|---|---|---|
| `0x01` | `header` | first record of a base | object count u32, covered `seq` u64 (the last `seq` the base includes), document bounds (4×f32), offset and length of `index`, `ids` and `refs` (6×u64) |
| `0x02` | `index` | base | packed Hilbert R-tree (below) |
| `0x03` | `ids` | base | id lookup table (below) |
| `0x04` | `refs` | base | reverse reference table (below) |
| `0x10` | `object` | anywhere | id, `seq` and summary, then writes and a body update (below) |
| `0x20` | `cursor` | load responses | `epoch` string: the working set the response was read from |

The header is fixed-width so its offsets do not depend on their own encoded length. All offsets in a base (header, index leaves, `ids`, `refs`) are absolute u64 file offsets of a record's first byte, its `kind`. The format version is the preamble's `version` byte alone.

### `object`

| Field | Encoding |
|---|---|
| `id` | string (varint length + UTF-8) |
| `seq` | varint: 0 from a client, the server's order otherwise; in a base, the covered `seq` |
| `bbox` | 4×f32, world-space AABB including rotation and stroke width; for connectors, the union of the route and its endpoints |
| `refs` | count varint, ids |
| `flags` | u8 — `deleted`, `full` (the record holds every property and the whole body) |
| `groups` | count varint; group = `counter` varint, `writer` u64, count varint, then (key string, value) pairs |
| `body` | bytes: a Yjs update for the body, empty for none |

A record from a client has one group: its transaction. A base record has one group per distinct timestamp among the object's winning values, and `body` is the body's whole state (`Y.encodeStateAsUpdate`). A create is the object's first record and carries `full`. A summary-only record has no groups and no body.

Values are tagged:

| Tag | Value |
|---|---|
| `0` | `null` (the key is removed) |
| `1`, `2` | `false`, `true` |
| `3` | f64 |
| `4` | string |
| `5` | bytes |
| `6` | JSON string, for plain objects and arrays in `data` |

### `index`

A packed Hilbert R-tree, as in FlatGeobuf. Objects in a base are sorted by a Hilbert key of their bbox centre, computed on a fixed grid of one-world-unit cells centred on the origin (2³² per axis, a u64 value, clamped at the edges), not on the document bounds, so an object's key depends only on its own bbox. The order also makes objects close on the canvas close in the file. The tree is stored root-first; node size is 16. Internal entries are 4×f32 bbox plus a u64 child node index. Leaf entries are 4×f32 bbox, the u64 file offset of the `object` record, and the u64 Hilbert key the object was sorted by (≈ 32 bytes per object). The key is stored because a base rewrite can widen a bbox without moving its object (see Compaction), after which the key no longer follows from the bbox.

A query walks the tree with the viewport and returns leaf offsets, which collapse into a few contiguous byte ranges thanks to the Hilbert order; ranges less than 16 KB apart are read as one (4 ranges instead of 39 for a viewport at zoom 2, 15% more bytes).

The working set reads the whole `index`, `ids` and `refs` of its base once and keeps them (about 64 bytes per object, 6.4 MB at 100k), so queries and their reference closures cost no range reads. Walking the index with a range read per node would take 67 reads for one viewport at zoom 1.

### `ids`

Fixed-width entries sorted by key, so a lookup is a binary search: `hash u64 | recordOffset u64`, where `hash` is the first 8 bytes of SHA-256 of the id. On a hash match the reader decodes the record and compares the full id, continuing over neighbouring entries with the same hash.

### `refs`

The same layout as `ids`, keyed by the hash of a referenced id: one `hash u64 | recordOffset u64` entry per (object, ref) pair, pointing at the referencing object. A lookup returns candidates whose `refs` field the reader then checks for the full id. For an object with segment records, the segment map's reverse refs replace its entries here, since its base `refs` may be out of date.

### Base file order

```
magic | header | index | ids | refs | object × n (Hilbert key order, ties by id)
```

The index precedes the objects, so a reader holding the header and index can range-read just the objects it needs. A base holds one record per id and no deleted objects.

## Storage

A canvas is a set of immutable blobs under the existing `documents/<id>/` prefix, found by name:

- `base-<uuid>.vcanvas` — the current base. The row's `content_key` points at it, through the existing spill path (`#db/space/documentContent.ts`); a canvas always spills, whatever its size, and `content` stays empty.
- `seg-<firstSeq>-<lastSeq>.vcanvas` — `object` records in `seq` order, no index: a flush, or a merge of adjacent segments spanning their ranges.
- `fold-<uuid>.vcanvas` — a base rewrite's merged objects while it runs (see Compaction).

Opening a canvas reads the base header and lists the `seg-` prefix. A listed segment is live unless the base covers it (`lastSeq` ≤ the header's covered `seq`) or another listed segment's range contains its own (a merge already includes it). The last `seq` is the highest live `lastSeq`, or the header's covered `seq` when no segment is live (after a base rewrite or a restore), and the next one follows it. Records that never reached a segment had no name, so their `seq`s are reused without a collision.

Commit points:

- A flush commits with the `put` of its segment; no row is written.
- A base rewrite or restore commits by updating `content_key`, conditional on it still naming the base the operation started from, as for spilled content today.

Garbage, deleted by GC only after one hour, which covers open reads and the gap between a base's write and its commit:

- a segment the current base or another segment covers;
- a base neither the row nor a revision names;
- a fold once its rewrite ends.

## Writing

The server keeps one working set per open canvas: its `epoch`, the `seq` counter, the document bounds (the base header's, grown by every record since), the records not yet flushed, the **segment map** `id → (summary, record locations)` for every object with records in the listed segments or the pending buffer, and its reverse `ref → ids`, both stored as columns (see Memory). Opening a canvas builds the map by streaming the segments once. The map is bounded by compaction and holds no payloads; the server never holds objects.

1. A client sends a `CanvasOps` frame: the `epoch` it holds, an `opId`, and `object` records.
2. The server checks write access and readonly, drops a frame from another epoch (one sent before the client received a `CanvasReload`; see Other consumers), and checks each summary for well-formedness and size limits. It drops records without `full` for ids that exist in neither the map nor the base.
3. Each record gets the next `seq`, written into the record, updates the segment map, is appended to the pending buffer, and the frame is broadcast to the room, the sender included, carrying its `opId`. A frame whose records were all dropped is still echoed to its sender, with no records. Every frame from the current epoch thus gets an echo, and an echo covers every record of its frame; the records missing from it, by id, were dropped. A frame from another epoch gets none, because its sender is about to reload.
4. A flush (1 s after the oldest pending record, 64 KB pending, the last client leaving, server shutdown, or the working set being evicted) writes the pending records as `seg-<firstSeq>-<lastSeq>.vcanvas`, then broadcasts `CanvasFlushed` with the flushed `seq` and the document bounds. One flush runs at a time, so segments commit in `seq` order and a live segment never follows a gap. A failed write is retried under the same name; the records stay pending and no `CanvasFlushed` is sent until the `put` succeeds.

Nothing is rejected and the server never merges on the write path: merging happens where the state is needed.

**Gestures commit once.** A drag, resize or rotate writes the properties when the pointer is released, as strokes already do (`strokePreview`). A drag is one record per object. An interrupted gesture commits nothing. Other clients see the result when it commits (see Non-goals). Typing is not a gesture: every editor transaction in a body is a record, so others see text as it is typed.

### Durability

Clients see ops at broadcast, before they are durable. Every client keeps a **resend buffer**: the records it sent that no `CanvasFlushed` covers yet, encoded as sent, and the **body resend set**: the bodies it sent or applied an update to that no `CanvasFlushed` covers yet.

A graceful shutdown or eviction flushes first. A crash loses the unflushed records and drops every socket, and the next open starts a new working set with a new `epoch`, continuing after the highest live segment (see Storage). On every reconnect, whether the server restarted or only the connection broke, the client joins again and:

1. **Catches up.** It loads with `since` set to the last `seq` it received on the socket. In the same epoch, with no base rewrite covering past `since`, the server returns every record after it, from the segments and the pending buffer: exactly what the socket would have delivered. The client applies them as live ops (see Live protocol). Otherwise the server answers that it cannot, and the client resynchronises: a load naming every object it holds, deleted ones included, plus its region (see Loading).
2. **Resends** every record in its resend buffer, unchanged, and for each body in its body resend set one record with the body's whole state. Echoes give them new `seq`s; corrections follow from the echoes as for any record (see Summary).

Resending is idempotent: a property write keeps its timestamp, so a write the server already had changes nothing, and a body update merges as a no-op. A resent write never overrides a later write, so the client resends without knowing which of its frames arrived.

Bodies are resent whole, not just the client's own updates, because a body update can depend on another client's. If Q's typing is lost in the crash and Q is gone, P's later typing next to it would stay pending on every other client. P applied Q's update, so P's whole body carries it. Properties need no such care: no write depends on another.

Nothing a connected client wrote is lost, nor a body update it still holds. Records that only a departed client held are lost, at most one flush interval, and no surviving record depends on them: property writes depend on nothing, and building on a body update requires holding it.

### Compaction

Compaction has two tiers, so its cost follows the edits, not the document. Both run in the serializer worker, one at a time per document, and hand their result to the working set, which commits it: a segment merge by its `put`, a base rewrite by updating `content_key` conditional on the base being unchanged (a restore during compaction discards the result).

**Segment merge**, size-tiered: whenever 4 adjacent segments are within 2× of each other in size, they are merged into one `seg-<firstSeq>-<lastSeq>.vcanvas` spanning their ranges: one record per id, with the latest summary and `seq`, the winning value per key, and the body updates combined by `Y.mergeUpdates`, which works on the encoded updates without loading a doc. The record is `full` if any input is. The ids and their record locations come from the segment map. The merge takes them in Hilbert order of their latest bbox, which keeps the records of one view close in the output, and works in chunks of up to 8 MB of input records like the fold below: each chunk reads its records as ranges sorted by offset, coalescing gaps under 16 KB, then merges and writes them id by id. A record is rewritten once per tier, the segment count stays logarithmic in the segments' total size, and no merge rewrites a large merged segment for a few small ones.

**Base rewrite**, when segments exceed 25% of the base's size (and at least 1 MB). It covers the segments present when it starts, which are contiguous in `seq` because flushes commit in order. Every blob is read sequentially or in coalesced ranges, never one range per object:

1. Build the object table (see Memory) from the base's cached `index`, `ids` and `refs`, without reading its objects: an unchanged record's length is the distance to the next record offset, or to the end of the file for the last. Then take the changed objects' latest summaries and record locations from the segment map. Add the connectors that reference a changed object, through the `refs` table and the segment map's reverse refs, with a visited set: they have no new records, but their routes may have moved.
2. Sort the changed ids by the Hilbert key of their latest summary's bbox.
3. **Fold** the changed objects, in that order, into a temporary `fold-<uuid>.vcanvas` written through `putStream`, in chunks of up to 8 MB of input records. A chunk first reads its records from the base and from each segment as ranges sorted by offset, coalescing gaps under 16 KB, as loads do. Then, for each object, it merges the properties (the winning value per key) and, for a body, loads the base state and updates into a Y.Doc and re-encodes it, which garbage-collects deleted content, and appends the record to the fold. Before computing the bounds of the chunk's connectors, it resolves their endpoints: the objects named in their `refs.*` properties, and theirs in turn, as rendering resolves them, that are not in the chunk. They are read in one more round of coalesced ranges per hop, from the base and, for changed ones, the segments, and merged for their geometry only; nothing is written for them. An object with `deleted` set is dropped; the summaries' `deleted` flag is not consulted. The table keeps the record's length, its fold offset, the widened bbox and the `refs` (see Summary). Unchanged objects are not read: the base holds no deleted objects, so they are all live.
4. Order the live objects by Hilbert key, ties by id: unchanged ones by the key stored in their index leaf, changed ones by the key from step 2, so both the old base and the fold are already in output order. A bbox widened in step 3 goes into the index with its object's key unchanged; the order is only for locality, and the index stays exact.
5. Build `index`, `ids` and `refs` from the record lengths, and stream the output through `putStream` as `base-<uuid>.vcanvas`: header, with the last covered segment's `lastSeq` and exact bounds, index, ids, refs, then the objects, merged from two sequential reads: the old base for the unchanged objects and the fold for the changed ones. Each object is encoded once.
6. Point `content_key` at the new base, and replace the cached `index`, `ids` and `refs` with the new ones. The segments it covers and the fold are garbage from then on (see Storage); segments flushed since it started stay live. Drop the map entries it folded.

With 10 MB of segments on a 40 MB base, a rewrite reads each segment about twice (two chunks), the base once in full and once in the ranges of the changed objects, and the fold once.

Clients are not told: they already hold everything the new base holds.

### Memory

The segment map, its reverse refs and the rewrite's object table are typed-array columns indexed by object number, with ids in one UTF-8 arena and record locations and refs in pooled linked lists. A `Map` entry holding an id string, a bbox and arrays costs 150–300 bytes; the columns cost about 100. A base rewrite at 100k objects holds 10 MB of table, one 8 MB fold chunk and one body Y.Doc at a time. The working set holds the same columns for the objects in its segments only, which compaction bounds, plus the base's `index`, `ids` and `refs` as read (6.4 MB at 100k). These figures are computed from the layout, not measured; the scale tests check them.

## Loading

`POST /api/v1/spaces/:space/documents/:id/canvas` takes a JSON query and returns `application/vnd.vektor.canvas`. It is a POST because a resync names thousands of ids.

| Query | Returns |
|---|---|
| `{ view: [x0, y0, x1, y1] }` | objects whose bbox intersects the rect |
| `{ ids: [a, b, …] }` | the named objects, via the `ids` table, deleted ones included; combined with `view`, the union |
| `{ since, epoch }` | every record after `since` (see Durability), or `409` when the epoch differs or a base rewrite covers past `since` |
| `{}` | every object (export, agent, search indexing) |

Matching uses the latest summary: the map's for objects with segment records, the base's otherwise. Deleted objects are skipped unless named in `ids`, so a client holding one receives its delete. A named id that no longer exists at all (a base rewrite dropped it) is answered with a summary-only record flagged `deleted`, so the client drops it too.

Every `view` and `ids` response closes the matches over `refs` in two steps:

1. **Referencing**, transitively: the objects that reference a returned object, via the `refs` table and the map's reverse refs, with a visited set. A client holding a shape holds the connectors attached to it, and the connectors attached to those.
2. **Referenced**, one hop: the objects named in the `refs` of every object returned so far, via the `ids` table. A client holding a connector holds both its endpoints, which it needs to compute the connector's bbox when one of them moves. These are not closed again: following referencing objects from an endpoint would pull in every connected diagram.

An object reached only in step 2 is **partial**: the client holds it, but not necessarily everything that references it. The client renders it, and before it edits it, loads it again with `ids`, whose step 1 brings in its referencing objects. A partial endpoint that is itself a connector gets its own endpoints the same way, before the client has to compute its bbox.

The server queries the cached index and tables and the segment map. It then streams:

1. A `cursor` record with the working set's `epoch`.
2. For each matching object, its base record (if any) from its byte ranges via `readStream`, then its segment records, by range read or from the pending buffer. The client merges them; the server does not.

The response takes the matching objects' record locations and its references to their pending records when it starts. Records are immutable, so a flush that moves pending records into a segment, or a later merge, does not change the bytes the response holds. Records that arrive after it starts reach the client live (see Join order).

Responses carry no `header`, `index`, `ids` or `refs`. A base or segment a response is reading stays in the blob store until the response ends: GC deletes a blob only an hour after it became garbage (see Storage).

### Join order

The client joins the room before loading and receives the room's `epoch`. A response whose `epoch` differs is discarded and retried.

A rect counts as loaded from the moment it is requested. While any request is outstanding, the client keeps every live record for an object it does not hold, and merges those records into the object when a response delivers it. Otherwise an op that moved an object away while the response was reading it would never reach the client, which did not hold the object yet, and the response's older state would stay. Merging is order-independent, so the kept records apply after the response's older ones without checking `seq`. Kept records are dropped once every request that was outstanding when they arrived has finished.

## Live protocol

New `WsMsgType`s in `#realtime/protocol.ts`, framed like the Yjs frames: `[type u8][documentId length u32 BE][documentId UTF-8][payload]`. Op payloads use the format's encodings; the small control payloads are JSON, as the existing JSON frames are.

| Type | Frame | Direction | Payload |
|---|---|---|---|
| 16 | `CanvasJoin` | client → server | empty |
| 17 | `CanvasLeave` | client → server | empty |
| 18 | `CanvasJoined` | server → client | JSON `{ epoch, seq, bounds }` |
| 19 | `CanvasOps` | client → server | `epoch` string, `opId` string, records |
| 19 | `CanvasOps` | server → client | `opId` string, records with their `seq` |
| 20 | `CanvasFlushed` | server → client | JSON `{ seq, bounds }` |
| 21 | `CanvasReload` | server → client | JSON `{ epoch, seq }` — after a revision restore |

Records are the file's records, `kind | length | payload`, so a client decodes live ops and load responses with the same decoder. A client starts its received `seq` at `CanvasJoined.seq` and advances it with every record the socket delivers, in order; load responses do not change it.

Every op goes to every room member, on one ordered socket per client. A client applies every record for an object it holds. A record for an object it does not hold, whose `refs` name an object it holds or whose bbox intersects the loaded region, brings that object in:

- With `full`, the record is the object's whole state, and the client adds it.
- Without `full`, the record holds only some keys, and a body update may depend on state the client never loaded. The client keeps the record, requests the object with `ids`, and merges the kept records into it when the response delivers it, exactly as during a region load (see Join order). A shape moved into the region by another client arrives this way.

The client keeps the remaining records while requests are outstanding (see Join order). The client keeps no summaries: for an object it holds, it computes bbox, `refs` and `deleted` from its state, as the op writer does, so no response can leave an older summary behind. A record's summary is read only to decide whether it brings an object in. Presence entries live in the canvas room, as they live in the Yjs room today (`yRooms` in `#realtime/presence.ts`), so removing the canvas Yjs rooms keeps presence.

### Walkthrough

Clients P and Q have loaded a region holding shape A and connector C (`refs` [A]). R is joined but has not loaded A's area.

| # | What happens | Server | Clients |
|---|---|---|---|
| 1 | P drags A | | only P previews the drag |
| 2 | Q recolours A mid-drag | Q's write (`style.color`) gets seq 101 | P and Q merge it; P keeps previewing its drag on top |
| 3 | R starts loading A's area | it reads A's base record and record 101 | |
| 4 | P releases: A gets `frame.x`, `frame.y`, the summary the new bbox (outside R's region); C gets a summary-only record with its new bbox | seqs 102–103, broadcast | Q merges: A has P's position and Q's colour |
| 5 | Op 102–103 reaches R before the response's A | | R does not hold A, a request is outstanding: kept |
| 6 | The response's A arrives | | R merges the kept 102 into it: A is where P put it, outside R's region |
| 7 | Q resizes A at the same moment as P moves it again | P's record is 104, Q's 105; the last summary is Q's, with A's old position | everyone merges position and size. P's echo (104) comes before 105, so P's summary matches its state. Q's echo (105) comes after 104: Q's summary misses P's move, and Q sends the correction, 106 |
| 8 | P and Q type into A's label at the same moment | body updates 107 and 108 | everyone merges both insertions |
| 9 | Flush | `seg-101-108.vcanvas`, `CanvasFlushed` 108 | clients clear their resend buffers up to 108 |

Every client ends with the same state for A, and the index with A's true bbox.

## Client

The canvas controller replaces the room-wide Y.Doc and its `observeDeep` sync (`#canvas/runtime/controller.ts`) with:

- **Object store**: for each held object, its properties as `key → (value, timestamp)`, and for a body its encoded state and decoded text. Incoming body updates are merged with `Y.mergeUpdates` and decoded through a short-lived Y.Doc. A Y.Doc costs about 8 KB in memory, so one is kept only for a body being edited or in the undo stack.
- **Streaming decoder**: merges objects into the store as records arrive and requests a render per batch.
- **Region loader**: on viewport change, it requests the part of the viewport, padded by 50%, that no loaded rect covers, and records the rect. Objects beyond 3× the viewport are evicted unless selected, being edited or in the undo stack, and evicting them shrinks the loaded rects to match. An object and the objects it references or that reference it are evicted together, so the store stays closed over `refs` as loads leave it.
- **Op writer**: sends each local transaction as a record, with the summary computed from the object's state. Editing a shape also sends summary-only records for the connectors that reference it, and for those referencing them in turn, so their bboxes stay true; the client holds them and their other endpoints, because every load returns referencing objects and the endpoints of what it returns, and a partial object is reloaded before it is edited (see Loading).
- **Undo**: an app-level stack that groups the objects one user action touched. A property undo writes back the previous value of each key the action wrote, for keys whose winning value is still the action's write; a key another user has since overwritten keeps their value, as today. A body's undo is a `Y.UndoManager` on its doc, tracking local origins, grouped under the same stack.

The client never assumes it holds every object:

- **Fit to content, minimap**: use the working set's document bounds, sent in `CanvasJoined` and updated with each `CanvasFlushed`.
- **Select all**: a load with an empty query, so every object is held before it is selected.
- **Search**: runs on the server over the full document, as search indexing does (see Other consumers), and the client loads the matches with `ids`.
- **Moving a section**: loads the section's bbox first, so contained objects are present.
- **Connectors**: arrive with their endpoints (see Loading); only a partial connector loads its own endpoints with `ids`, when it is edited.

### Client state

Everything a client keeps beyond rendering, in one place:

| State | Holds | Dropped |
|---|---|---|
| `writer`, counter | the session's write timestamps | never; the counter only grows |
| Object store | properties of each held object, encoded state and decoded text of its body | on eviction (beyond 3× the viewport, unless selected, edited or in the undo stack, with its `refs` neighbours); all of it on `CanvasReload` |
| Body docs | a Y.Doc, with a fresh Yjs `clientID`, for each body being edited or in the undo stack | when the edit ends and the body leaves the undo stack |
| Loaded rects | the areas requested so far | shrunk on eviction; all on `CanvasReload` |
| Kept records | live records for objects not held, while a request is outstanding | once every request outstanding when they arrived has finished |
| Received `seq` | the last `seq` the socket delivered, for catching up | advanced by each live record; reset to `CanvasReload.seq` |
| Resend buffer | own records no `CanvasFlushed` covers | when a `CanvasFlushed` covers its echo's `seq`; all on `CanvasReload`. Resent on every reconnect |
| Body resend set | bodies with updates, own or applied, no `CanvasFlushed` covers | when a `CanvasFlushed` covers the last one; all on `CanvasReload`. Resent whole on every reconnect |

## Zooming out

There is no level of detail or size culling: the client's zoom stops at 0.15 (`minZoom` in `#canvas/runtime/controller.ts`), and fit to content at 0.25. On the 100k-stroke prototype board, a 1920×1080 viewport at 0.25 holds 2,705 objects (0.95 MB); at 0.15 it holds about 2.8× as many, 7.5k objects (2.7 MB). Zooming out further would need one, because the object count, not the bytes per object, is the cost.

## Rich-text documents

A rich-text document maps onto the same model as one object with a body: the body is the document's Y.Doc as today, and the file is a base with one record plus segments of body updates. Merging, catching up by `since`, resending, compaction (`Y.mergeUpdates` for segments, re-encoding at a base rewrite) and revisions work as for a canvas; the spatial index is not needed. Rich text stays on its current storage and Yjs rooms until canvases run on the object store; moving it is its own change, and replaces the Yjs rooms and checkpoints in `#realtime/yjsRooms.ts` for documents too.

## Other consumers

- **Revisions**: a revision's `snapshot` is a base key. Taking one flushes the working set and runs a base rewrite, unless no segment is live, so it covers every broadcast op; the new base serves the document and the revision. Canvas revisions come from explicit saves and restores only; collaboration checkpoints already skip canvases (`#realtime/yjsRooms.ts`).

  `#db/space/revisions.ts` keeps its rows, numbering and coalescing, and changes only what a canvas snapshot holds:

  - `snapshot` is the base key as UTF-8, a few dozen bytes, always inline and never brotli-compressed; the base is already compact, and compressing 40 MB would cost seconds.
  - `checksum` is the hash of that key. A save with no live segment reuses the current base, so its checksum matches the last revision and the existing identical-content path returns that revision.
  - A save within the 3-hour overwrite window swaps the row to the new base key, as it swaps a snapshot today. The replaced base is garbage once no row names it (see Storage), so there is no spilled snapshot to delete.
  - Reading a revision, including a published one (`resolvePublishedDocumentContent`), is a load from its base alone, with the same queries; segments never apply to it. Restore discards the pending buffer, copies the revision's base to a new `base-<uuid>.vcanvas` with the header's covered `seq` set to the last `seq` (see Storage), so every existing segment is covered, points `content_key` at it, starts a new epoch, rebuilds the segment map, and broadcasts `CanvasReload`. Clients drop their store, their body docs, their undo stacks, their resend buffers and body resend sets, then reload. Nothing is resent: the restore replaces the document, and edits built on the replaced state are discarded deliberately. GC keeps every base a revision names.
- **Agent edits**: replace the JSON edit path in `#realtime/yjsRooms.ts` (`syncCanvasCollection`) with a load query and `CanvasOps` submitted by the server, as a writer with its own `writer` and counter. It has no echo, so it computes summaries from the state it loaded and leaves stale ones to the next base rewrite. A tool call returns once a `CanvasFlushed` covers its records, so a crash cannot lose an edit the agent was told succeeded. Agent edits no longer create a revision per call (`document-canvas.ts`). Agent presence is unchanged.
- **Agent canvas API**: `document-canvas.ts` (describe, and operations applied to the parsed snapshot) and `document-canvas-render.ts` (PNG of a region) read the whole JSON snapshot through `canvasRequest`. Describe and render read a full or `view` load instead; operations go through the agent edit path. Describe and select-all hold every object they load; they are outside the goal of never holding a whole canvas, as they are today.
- **Search, export, templates**: stream the full document through the decoder, decoding bodies to text.

## Tunables

Values marked *measured* come from the prototype (below); the others are still to be checked against a replay of a recorded editing session.

| Tunable | Value | Bounds |
|---|---|---|
| Flush delay | 1 s after the oldest pending record | edits lost on a crash from a client that is gone too |
| Flush size | 64 KB | the pending buffer |
| Segment merge | 4 adjacent segments within 2× in size | segments per open and per load |
| Base rewrite | segments > 25% of the base, ≥ 1 MB | write amplification: a base is rewritten at most once per quarter of its size in edits; a base rewrite also ends catching up by `since` for clients that were away across it |
| Fold chunk | 8 MB of input records | rewrite memory against passes over the segments |
| GC age | 1 h | must exceed the longest base rewrite and the longest open read |
| Range gap | 16 KB | *measured*: range reads per load against wasted bytes (4 ranges instead of 39, +15% bytes) |
| Region padding, eviction | 50%, 3× | requests while panning against client memory |
| Index node size | 16 | *measured*: 8, 16 and 32 read the same bytes; with the index cached, node size only affects build time |
| Point quantization | 1/64 world unit | error under 0.08 px at the maximum zoom, against bytes per stroke |

## Prototype results

A Bun prototype of the format, on a board of 100k strokes from the real `createFreehandRecorder` (22 points each, 200 clusters over 40k × 40k world units) plus 2k notes. It stored each element as a Y.Doc update rather than timestamped properties, quantized points at 16 units per world unit instead of 64, skipped elements under 1 px in views, and its records lack `type`, `z`, `updatedAt`, `authorId` and `refs`, so its size and viewport rows are to be re-measured. The range and index results depend only on the layout and the Hilbert order.

| | |
|---|---|
| Size | 39.6 MB base against 178 MB of JSON today; index 2.5 MB, ids 1.6 MB |
| Viewport 1920×1080 at zoom 2 / 1 / 0.25 | 290 / 712 / 2,705 elements, 0.10 / 0.25 / 0.95 MB, 4 / 4 / 7 ranges with 16 KB gaps (39 / 26 / 35 exact) |
| Client memory per element | Y.Doc 8.2 KB, encoded state with decoded value 0.4 KB |

## Removed

- The room-wide canvas Y.Doc: `seedCanvasDoc`, `withPinnedYjsSeed` for canvases, `parseCanvasContent` and `mapSnapshotFromDoc`. Objects are created once (by the creating client, or at migration) and never re-seeded, so ids need no pinning.
- The `map-snapshot` format in `#documents/serialization.ts` and its rooms in `#realtime/yjsRooms.ts`.
- `data.text` on shapes, replaced by bodies.
- The 5 s persist throttle and large-payload brotli quality for canvases.
- The content spill path for canvases.

## Migration

One cutover: at startup, before it serves canvases, the new version converts every canvas's JSON snapshot into a base file and points `content_key` at it, and converts each canvas revision the same way, each to its own base. A canvas whose `content_key` already names a `base-` blob is skipped, so a migration interrupted by a crash resumes where it stopped. Opening a canvas never converts anything. This is the one point where the server holds a whole canvas: it parses the snapshot as every load does today, so a canvas that opens today migrates.

The conversion runs in the serializer worker, in the same two passes as a base rewrite. The first pass builds each shape's and stroke's record, keeps its id, bbox, refs and encoded length, and discards the record. The second, after the Hilbert sort, writes header, index, ids and refs, then builds each record again and streams it. Peak memory is the parsed snapshot plus the object table (about 100 bytes per object, see Memory); neither the records nor the 40 MB base are held. No dual read path afterwards.

- Every property gets the timestamp `(1, 0)`: writer 0 is reserved for migration.
- Strokes have no `z` today and render in `updatedAt` order (`syncStrokesFromY`). Migration assigns their `z` from that order.
- Connectors get `refs.start` and `refs.end` from their endpoints. `line` is built in, and the server already resolves its `data` (`resolveLine`); an extension type with references supplies the same mapping for migration.
- `data.text` becomes the body, built with the editor schema as the server already builds Y.Docs from content (`#documents/schema/yEncode.ts`).
- The bbox comes from `shapeBounds`, without text layout. Text that overflows its frame is repaired by the first client with write access that renders it (see Summary).

## Module layout

Following the canvas layering (`geometry → render/input → document → …`), the format lives in `#canvas/document/format/` and is imported by both client and server:

- `records.ts`: varints, values, record encode/decode, stroke points.
- `properties.ts`: timestamps and the per-key merge.
- `hilbert.ts`, `rtree.ts`: index build and query.
- `lookup.ts`: the `ids` and `refs` tables.
- `stream.ts`: incremental decoder over a `ReadableStream<Uint8Array>`.
- `object.ts`: objects: creating, merging, bodies, summaries.

The server side (segment listing, flush, compaction, query) lives in `#db/space/canvasStore.ts`, and the room in `#realtime/canvasRooms.ts`.

## Testing

Integration level only, with browser clients against the server.

**Convergence**
- The walkthrough above, asserting the final state and summaries.
- Two clients editing different keys, and the same key, of one shape concurrently: both converge as with Yjs today.
- Two clients typing into one text shape at the same moment: both insertions land on every client and survive a reload.
- A client that edits a shape, pans until it is evicted before the next flush, pans back and edits it again: every client converges.

**Summaries**
- A concurrent move and resize of one shape, once with the resizing client connected and once with it gone before its echo: after its correction or the next base rewrite, a `view` query at the merged position returns the shape.
- Two clients changing the two ends of one connector concurrently, by moving the endpoints and by reattaching them to other shapes, the later one connected or gone before its echo: after the correction or the next base rewrite, the connector loads with each endpoint and with a `view` over its merged route.
- Moving a shape reached only as a connector's endpoint, while another connector off-view references it: the other connector's bbox follows.

**Loading**
- A viewport load returns exactly the intersecting objects, the connectors attached to them and their endpoints, and a connector follows when its endpoint moves.
- Panning while another client moves and deletes objects across the edge of the region: no object comes back in its old state, and a shape moved in from off-view appears at its new position with its full state.

**Durability**
- A server restart between broadcast and flush, after Q recoloured a shape and left and P recoloured it again: clients reconnect, catch up and resend, every connected client's edit lands, and the shape has P's colour.
- The same with Q and P typing into one text shape: P's text and the part of Q's that P held survive.
- A connection drop while another client edits: on reconnect the client catches up by `since`, and its frames sent into the dropped socket land once, with no later write overridden.
- A connection drop while another client moves a held shape out of the region and deletes another: on reconnect the first is at its new position and the second is gone, on the client and in the index; the same across a base rewrite, through the resync.
- A revision restore while another client edits: the client reloads the restored state, and its next edit lands.

**Deletion, undo and compaction**
- A real canvas through migration → load → edit → compaction → load: rendered snapshots match.
- Deleting a shape and undoing after a base rewrite dropped it: the shape comes back with its state.
- Undoing a shape's creation: it is deleted on every client and in the index; redoing brings it back.
- Undoing a recolour after another client changed the same shape's colour: the other client's colour stays.
- A base rewrite over a shape whose last summary says `deleted` while its properties do not: the shape survives.

**Scale**
- A 100k-stroke board: load time and server memory against today; a viewport at minimum zoom over its densest area stays under 3 MB; a base rewrite and a migration stay within the bounds in Memory.
- A stroke drawn at the maximum zoom, reloaded: its rendered snapshot matches the original.

## Open questions

- Bodies keep their history until a base rewrite re-encodes them. Whether any shape's text grows enough in practice to matter.
- Whether the region loader should send its loaded rects so the server can subtract them, instead of the client computing uncovered areas.
