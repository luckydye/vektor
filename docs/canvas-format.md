# Canvas format

Canvases become a single binary wire format (`.vcanvas`) that is at once the stored file, the HTTP response and the live-op frame. It streams front to back, and a spatial index lets a reader fetch only the elements in view.

## Where we are

- A canvas is persisted as one JSON snapshot `{ version: 1, shapes, strokes }` in `document.content`, spilled to the blob store above 1 MB (`#db/space/documentContent.ts`).
- Live editing runs through a Yjs room. Every persist re-serializes the whole doc (`contentFromDoc` → `JSON.stringify`, throttled to 5 s because it stalls the event loop), and every load re-seeds a Y.Doc from JSON with pinned ids (`seedCanvasDoc`, `withPinnedYjsSeed`).
- Revisions brotli the full JSON (`#db/space/revisions.ts`), with quality dropped for large canvases.
- Strokes store points as `{ x, y, width }` objects. Images are already references.
- The canvas only uses Yjs as nested last-writer-wins maps (`canvas.shapes`, `canvas.strokes`): no `Y.Text`, `Y.Array` or `XmlFragment`.

Nothing can be loaded partially: a client needs the entire document before it renders anything, and the server needs it in memory to save.

## Goals

- Load streams: the first elements render before the last byte arrives.
- Load is spatial: a client fetches the elements intersecting its viewport, and more as it pans.
- Saving costs the size of the edit, not the size of the document.
- The server never holds a whole canvas in memory, including during compaction.
- No new SQLite tables. The canvas lives in the blob store; the document row only points at it.

## Non-goals

- Offline editing with merge. Edits made while disconnected are replayed on reconnect and win by server order.
- Partial loading for the other Yjs-backed document types. Rich text stays on Yjs.

## File layout

```
magic "VCNV" (4 bytes) | version u8 | flags u8
record*
record = kind u8 | length varint | payload[length]
```

All varints are unsigned LEB128; signed integers are zigzag-encoded. Floats are little-endian. Every record decodes without reading anything after it, so a reader processes records as they arrive and skips unknown kinds by `length`.

Two concatenated streams form a valid stream once the second's preamble (magic, version, flags) is dropped. A file is the log of everything written to it: for any element id, the last record wins.

### Versions

Order is decided by the server alone, never by client clocks. Every accepted record gets the next `seq`, and an element's **version** is the `seq` of its latest record. `updatedAt` is display metadata and never decides which record wins.

`seq` is not stored per record; it follows from position:

- A flushed segment's records are consecutive from the `firstSeq` in its name.
- A merged segment carries each record's `seq` explicitly, in a `seq` record before it (see Compaction).
- A live `CanvasOps` frame carries its first `seq`; its records are consecutive from there.
- Base records and restored files carry no individual version: everything in them is at the manifest's `floor` (below).
- A load response starts with a `cursor`, and every element in it is current to at least that `seq`, so the client holds it at version `cursor`.

`seq` restarts from the manifest after a server restart, so it is only comparable within one **epoch**: a random id the server picks when it opens a canvas's working set. Cursors are `(epoch, seq)`.

### Record kinds

| Kind | Name | Where | Payload |
|---|---|---|---|
| `0x01` | `header` | first record of a base | element count u32, document bounds (4×f32), offset and length of `index`, `ids` and `refs` (6×u64) |
| `0x02` | `index` | base | packed Hilbert R-tree (below) |
| `0x03` | `ids` | base | id lookup table (below) |
| `0x04` | `refs` | base | reverse reference table (below) |
| `0x10` | `element` | anywhere | one complete element (below) |
| `0x11` | `delete` | segments, live ops | `id` |
| `0x12` | `seq` | merged segments | `seq` varint: the version of the next record |
| `0x20` | `cursor` | load responses | `epoch` string, `seq` varint: the snapshot the response is consistent to |

The header is fixed-width so its offsets do not depend on their own encoded length. All offsets in a base (header, index leaves, `ids`, `refs`) are absolute u64 file offsets of a record's first byte, its `kind`. The format version is the preamble's `version` byte alone.

### `element`

| Field | Encoding |
|---|---|
| `id` | string (varint length + UTF-8) |
| `type` | string; `"stroke"` for strokes |
| `bbox` | 4×f32 — world-space AABB including rotation and stroke width; for connectors, the union of the route and its endpoints |
| `z` | f64 |
| `updatedAt` | f64 (ms) |
| `flags` | u8 — `locked`, `stampedShape` |
| `authorId` | string, empty when unset |
| `refs` | count varint, ids — the elements this one is derived from (a connector's endpoints, which may be connectors themselves), empty for most |
| `body` | tagged value (below) |

The fixed fields come first, so the index builder and viewport filter never decode `body`.

`bbox` is computed by the client, because only it can lay out text. It is rounded outward when narrowed to f32 (min towards −∞, max towards +∞): f32 resolution is about 0.1 world units far from the origin, and rounding to nearest would cull elements at the viewport edge. The server only asserts it is finite and ordered.

`refs` replaces knowledge of extension-defined `data`: a connector's endpoints live in its `data`, which the server and the generic client code cannot read, so the element declares them here. Loads use it to return dependent elements together with what they depend on (see Loading). A ref may dangle: an element whose endpoint was deleted keeps its `refs`, and its type's `resolve` already handles a lookup that finds nothing. Deleting an element also rewrites or deletes, in the same frame, the referencing elements the client holds, as the connector's type decides; one created concurrently with the delete is left dangling.

For shapes, `body` is a map of `frame`, `style`, `data`. For strokes, it is a map of `style`, `rotation` and `points`, where `points` is a bytes value:

```
scale varint                      // quantization, units per world unit (default 16)
count varint
x0 y0 zigzag varint, w0 varint    // absolute, quantized
(dx dy zigzag varint, dw zigzag varint) × (count − 1)
```

### Tagged values

A minimal self-describing encoding for `body`, written in-house (no new packages):

| Tag | Value |
|---|---|
| `0` `1` `2` | null, false, true |
| `3` | integer, zigzag varint |
| `4` | f64 |
| `5` | string |
| `6` | bytes |
| `7` | array: count varint, values |
| `8` | map: count varint, (string key, value) pairs |

A number is written as tag `3` only when `Number.isSafeInteger` holds and it is not `-0`; every other number, including `-0`, `NaN` and infinities, is tag `4`. `undefined` map entries are omitted, as in JSON.

### `index`

A packed Hilbert R-tree, as in FlatGeobuf. Elements in a base are sorted by the Hilbert value of their bbox centre, which also makes elements close on the canvas close in the file. The tree is stored root-first; node size is 16. Each node entry is 4×f32 bbox plus a u64 offset: a child node index for internal entries, the file offset of the `element` record for leaves (≈ 24 bytes per element).

A query walks the tree with the viewport and returns leaf offsets, which collapse into a few contiguous byte ranges thanks to the Hilbert order. Size filters (`minSize`, `maxSize`) apply to leaves only: an internal node's bbox is large even when all its children are small, so a zoomed-out load reads every leaf in view. The working set caches the top levels of hot indexes; the levels-of-detail phase is what removes this cost.

### `ids`

Fixed-width entries sorted by key, so a lookup is a binary search over range reads: `hash u64 | recordOffset u64`, where `hash` is the first 8 bytes of SHA-256 of the id. On a hash match the reader decodes the record and compares the full id, continuing over neighbouring entries with the same hash.

### `refs`

The same layout as `ids`, keyed by the hash of a referenced id: one `hash u64 | recordOffset u64` entry per (element, ref) pair, pointing at the referencing element. A lookup returns candidates whose `refs` field the reader then checks for the full id.

### Base file order

```
magic | header | index | ids | refs | element × n (Hilbert order)
```

The index precedes the elements, so a reader holding the header and index can range-read just the elements it needs. A base never contains `delete` records or duplicate ids.

## Storage

Per document, under the existing `documents/<id>/` blob prefix:

- `base-<uuid>.vcanvas` — the last base rewrite.
- `seg-<firstSeq>-<epoch>.vcanvas` — ordered segments since then: `element` and `delete` records, no index. The epoch keeps names unique: after a crash a new epoch reuses the `seq`s that were never flushed.
- `merged-<lastSeq>.vcanvas` — the result of a segment merge, in the same list and order, with a `seq` record before each record.

The manifest replaces the JSON snapshot in `document.content` (a few hundred bytes, never spilled):

```json
{
  "format": "vcanvas",
  "base": "base-….vcanvas",
  "segments": ["seg-1042-k3f9….vcanvas", …],
  "seq": 1107,
  "floor": 1041,
  "bounds": [x0, y0, x1, y1]
}
```

- `seq`: the last flushed `seq`.
- `floor`: the version of every element whose latest record is not in a segment after it — the last base rewrite's `seq`, or the restore's (see Revisions). Records in the listed segments with a `seq` ≤ `floor` are history a restore brought back and count as part of the floor.
- `bounds`: a superset of the document bounds. Flushes grow it; compaction makes it exact again. The header's bounds are only valid for the base.

The row write is the commit point, as for spilled content today. The working set is the only writer of the manifest: flushes, compaction results and restores are committed one at a time, each as a read-modify-write of the current row.

Blobs no manifest, revision or open read references are garbage. A blob is written before the row that references it, so GC only deletes blobs older than one hour; a fresh segment or base is never collected between its write and its commit.

## Writing

The server keeps one working set per open canvas: its `epoch`, the `seq` counter, `floor`, the records not yet flushed, the **segment map** `id → (version, fields, bbox, refs, file, offset, length, deleted)` for every record in the listed segments and the pending buffer, and its reverse `ref → ids`. `fields` maps each field path changed since the working set opened to the `seq` that changed it. Opening a canvas builds the map by streaming the segments once; an entry's version is its record's `seq` raised to at least `floor`, so records from restored history count as `floor`. Field paths are not stored in files, so after an open every field of an entry is at the entry's version: merges are conservative until the next edit. The map is bounded by compaction and holds no payloads; the server never holds elements.

A **field path** is a fixed field name (`bbox`, `z`, `flags`, `refs`), a `body` key, or a key one level inside a `body` map (`frame.x`, `style.color`, `data.text`) — the granularity of the nested Yjs maps today.

Edits are a compare-and-set per field:

1. A client sends a `CanvasOps` frame: the `epoch` it holds, an `opId`, and records, each with a `baseSeq` (the version of the element it edited from, or `0` for a create) and, for an `element`, the field paths it changed. An edit that changes the element's extent lists `bbox` among them.
2. The server checks write access and readonly, rejects the frame if `epoch` is not the working set's (see Durability), and decodes the fixed fields for well-formedness and size limits.
3. It checks every record against the element's current version, `map[id].version` or else `floor`, and asserts `baseSeq` ≤ `seq`:
   - `baseSeq` ≥ the version: accepted as sent. This is the common case and decodes no `body`.
   - An older `baseSeq` on a live element: accepted when every listed field's version is ≤ `baseSeq`, that is, nobody changed those fields since the sender's base. The server decodes the current record and the sent one, copies the listed fields onto the current record, and accepts the result. Otherwise rejected.
   - An `element` on a deleted element with an older `baseSeq`: rejected, so stale clients cannot resurrect it.
   - A create (`baseSeq` 0): accepted only when the id is in neither the segment map nor the base's `ids` table, so a create can never overwrite an element or bring back a deleted one.
   - A `delete`: always accepted.
4. The frame is atomic. If any record fails, the whole frame is rejected with `CanvasReject` (`opId`, the failing ids), and nothing is assigned or broadcast. A shape and the connectors it rewrites therefore land together or not at all.
5. Otherwise each record gets the next `seq`, updates the segment map (its version and the versions of its listed fields), is appended to the pending buffer, and the frame is broadcast to the room, the sender included, carrying its `opId`. Merged records are broadcast as merged, so receivers only ever see whole elements.
6. A flush (1 s debounce, or 64 KB pending, the last client leaving, server shutdown, or the working set being evicted) writes the pending records as `seg-<firstSeq>-<epoch>.vcanvas`, updates the manifest (`seq`, `segments`, `bounds`), and then broadcasts `CanvasFlushed` with the flushed `seq`.

An edit to a deleted element fails the check, because the tombstone's version is above any `baseSeq` held from before the delete. After a base rewrite drops the tombstone, the id is in neither the map nor the base, so the edit is a write to a missing element and is rejected the same way. Deleted elements cannot be resurrected by stale clients.

Merging on the server is what keeps edits to different fields from starving each other: under compare-and-set on whole elements, a client farther from the server would lose every race against a drag on the same shape. Rejections are left for real conflicts, the same field changed by two clients.

### Durability

Clients see ops at broadcast, before they are durable. A sender keeps every op until a `CanvasFlushed` covers its `seq`, not just until the echo arrives.

A graceful shutdown or eviction flushes first. A crash loses the unflushed records, and the next open starts a new working set with a new `epoch`, continuing from the manifest's `seq`. (A revision restore also starts a new epoch, but clients handle it with `CanvasReload`, see Revisions.) The client cannot rely on its socket dropping to notice (a hibernated Durable Object keeps its sockets while its memory is gone), so every `CanvasOps` frame carries the epoch, and a frame from an old epoch is answered with `CanvasJoined` for the new one instead of being checked. A reconnecting client compares epochs too. On a change, it discards its loaded state, reloads its region, rebases every op not covered by a `CanvasFlushed` onto the reloaded elements (as on a rejection; a create whose id now exists becomes an edit of it), and resends. An op that was in fact flushed just before the crash rebases to a no-op change. Nothing a connected client wrote is lost; ops from a client that is gone too are lost, at most one flush interval.

### Compaction

Compaction has two tiers, so its cost follows the edits, not the document. Both run in the serializer worker, one at a time per document, and hand their result to the working set, which commits it conditional on `floor` being unchanged.

**Segment merge**, when there are more than 32 segments: the oldest segments, up to `seq` M, are merged into `merged-<M>.vcanvas`, keeping each id's latest record (tombstones included), each preceded by a `seq` record because the kept records are no longer consecutive. The base is untouched, versions do not change, clients are not told, and the cost is the size of the segments.

**Base rewrite**, when segments exceed 25% of the base's size (and at least 1 MB). It covers the segments present when it starts (up to `seq` S):

1. Stream base + segments, keeping only `id → (bbox, hilbert, refs, latest record location, length, deleted)`. Memory is O(elements × ~60 bytes), never payloads.
2. Sort live ids by Hilbert value, compute record offsets from the lengths, and build `index`, `ids` and `refs`.
3. Stream the output through `putStream`: header, index, ids, refs, then the elements. Unchanged elements are copied by one sequential read of the old base, which is already in Hilbert order for them; the changed ones are merged in from their segments by range reads grouped per segment.
4. Update the manifest to the new base plus the segments after S, with `floor` = S and exact `bounds`, conditional on `floor` being unchanged (a restore during compaction moves it and discards the result). Drop map entries with version ≤ S.

Segments flushed during compaction stay in the manifest untouched.

A base rewrite raises every folded element's version to S. The server then broadcasts `CanvasCompacted` with S, and clients raise every held version below S to S. That is sound because the socket is ordered: a client receiving it has seen every op ≤ S, and the seen-version rule (see Versions on the client) keeps an element from a region response that crosses it from being older than an op it saw. An op a client sent before receiving it fails the check once and is rebased like any other rejection.

## Loading

`GET /api/v1/spaces/:space/documents/:id/canvas` returns `application/vnd.vektor.canvas`:

| Query | Returns |
|---|---|
| `view=x0,y0,x1,y1` | elements whose bbox intersects the rect |
| `minSize=s` | additionally skips elements whose bbox is smaller than `s` world units in both axes |
| `maxSize=m` | additionally skips elements whose bbox is at least `m` world units in either axis |
| `ids=a,b,…` | the named elements, via the `ids` table; combined with `view`, the union |
| none | every element (export, agent, search indexing) |

Every response also includes the elements that reference a returned element, transitively (via the `refs` table and the map's reverse refs, with a visited set), so a client holding a shape holds the connectors attached to it, and the connectors attached to those.

The server reads the header and index with range reads (the top levels of hot indexes are cached in the working set) and resolves overrides with the segment map. It then streams:

1. A `cursor` record with the working set's `epoch` and current `seq`.
2. For each matching base element the map does not override, the base record, from its byte ranges via `readStream`.
3. For each matching live map entry, its record, from its segment by range read or from the pending buffer.
4. The referencing elements not already sent, resolved the same way.

Each id appears at most once and no tombstones are sent. Responses carry no `header`, `index`, `ids` or `refs`. Ops that land while the response streams can make an element newer than the cursor, never older: every element in a response is current to at least `cursor`, which is all the client relies on.

A base or segment a response is reading stays in the blob store until the response ends: GC deletes a blob only once no manifest, revision or open read references it.

### Join order

The client joins the room before loading, receives the room's `epoch`, and buffers live frames. Once the response's `cursor` arrives, it drops buffered ops with `seq` ≤ `cursor` and applies the rest in order, all through the version rule below. A response whose `epoch` differs from the room's is discarded and retried.

## Live protocol

New `WsMsgType`s in `#realtime/protocol.ts`, framed like the Yjs frames: `[type u8][documentId length u32 BE][documentId UTF-8][payload]`. Op payloads use the format's encodings (varints, strings, records); the small control payloads are JSON, as the existing JSON frames are.

| Type | Frame | Direction | Payload |
|---|---|---|---|
| 16 | `CanvasJoin` | client → server | empty |
| 17 | `CanvasLeave` | client → server | empty |
| 18 | `CanvasJoined` | server → client | JSON `{ epoch, seq, bounds }` |
| 19 | `CanvasOps` | client → server | `epoch` string, `opId` string, count varint, then per record: `baseSeq` varint, field count varint, field paths as strings, the record |
| 19 | `CanvasOps` | server → client | `opId` string, first `seq` varint, records |
| 20 | `CanvasReject` | server → client | JSON `{ opId, ids }` — to the sender only |
| 21 | `CanvasFlushed` | server → client | JSON `{ seq, bounds }` |
| 22 | `CanvasCompacted` | server → client | JSON `{ seq }` — after a base rewrite |
| 23 | `CanvasReload` | server → client | JSON `{ epoch, seq }` — after a revision restore |

Records are the file's records, `kind | length | payload`, so a client decodes live ops and load responses with the same decoder.

Every op goes to every room member, on one ordered socket per client. Clients apply every record for an element they hold, whose `refs` name an element they hold, or whose new bbox lies in the loaded region or in a region still being requested. Other records are not applied, but are still remembered while requests are outstanding (below). Presence stays on the existing presence rooms.

### Versions on the client

Every element a client holds carries its version: the `seq` of the op it came from, or the `cursor` of the response it came from. An incoming element or delete replaces held state only when its version is greater; equal versions are the same state.

While any region request is outstanding, the client also remembers the version of every record it sees, applied or not: `id → seq`, with deletes as tombstones. A response element is dropped when a remembered version is greater than its `cursor`. Without this, a response that read an element before an op moved it away (or deleted it) would bring back the old state for good, because the op was not applied to an element the client did not yet hold. An entry is dropped once every region request that was outstanding when it arrived has finished.

### Conflicts

Records are whole elements, and the server's compare-and-set decides. A client has at most one `CanvasOps` frame in flight. Changes made while it is in flight are merged locally per element and sent as one frame when the echo (or rejection) arrives, with `baseSeq`s taken from the echo. Otherwise a second edit to the same element, built on the version before the first edit's echo, would fail the check against the client's own first edit, and every move of a drag after the first would be rejected.

The server merges edits to different fields (see Writing), so a client only has to handle conflicts on the same field. It tracks its pending field edits per element, by field path. An op's fields are pending until its echo arrives; the op itself is kept for resending until `CanvasFlushed` covers it (see Durability).

On `CanvasReject`, the client takes the latest held version of each failing element (fetching it with `ids=` if it is not held), reapplies its pending fields on top, and resends the whole frame with the new `baseSeq`s. A remote record for an element with pending edits is applied as is and shown with the pending fields layered on top.

Two users editing different fields of one shape both keep their change, without a rejection. Editing the same field, the later accepted op wins; two concurrent drags of one shape alternate rather than merge, and whoever stops last wins, as with last-writer-wins in Yjs today. No client ever observes a record that drops another's accepted edit: a stale record is accepted only for fields nobody changed since its base, and the server copies just those.

### Walkthrough

Clients P and Q have joined epoch E and loaded a region at cursor 100 holding shape A and connector C (`refs` [A]). R is joined but has not loaded A's area. `floor` is 100.

| # | What happens | Server | Clients |
|---|---|---|---|
| 1 | P drags A: frame 1 = A (`frame.x`, `frame.y`, `bbox`) and C (`bbox`), both `baseSeq` 100 | versions are 100: accepted as sent, A@101, C@102 | broadcast to P, Q, R |
| 2 | P keeps dragging | | P has frame 1 in flight, so it merges the moves locally |
| 3 | Q recolours A: A (`style.color`), `baseSeq` 100, built on A's old position | A is @101 > 100, but `style.color` is @100: merged onto P's position, A@103 | Q's color and P's position both in A |
| 4 | R starts loading A's area | response cursor 103; it reads A@103 | |
| 5 | P receives the echo of 101–102 and sends frame 2, which moves A out of R's region: A `baseSeq` 101, C `baseSeq` 102 | A is @103, its listed fields @101: merged, keeping red, A@104; C @102: as sent, C@105 | |
| 6 | Op 104–105 reaches R before the response's A | | R does not hold A and the new bbox is outside the request: not applied, but remembered A → 104 |
| 7 | The response's A arrives, labelled 103 | | the remembered 104 is greater: dropped. Without the remembered version, R would show A where it no longer is, for good |
| 8 | Q drags A too: A (`frame.x`, …), `baseSeq` 103 | `frame.x` is @104 > 103: `CanvasReject` to Q | Q rebases onto A@104 and resends |
| 9 | Flush | `seg-101-E.vcanvas`, manifest `seq` 105, `CanvasFlushed` 105 | P and Q drop ops kept for resend up to 105 |

Every client ends with A at P's position in Q's color, and C following A.

## Client

The canvas controller replaces the Yjs `observeDeep` sync (`#canvas/runtime/controller.ts`) with:

- **Streaming decoder**: upserts elements into state as records arrive and requests a render per batch.
- **Region loader**: on viewport change, requests the viewport padded by 50%, and passes `minSize` = one screen pixel in world units. The loader records each loaded rect with the `minSize` it was loaded at. A request covers only what no loaded rect covers at that `minSize` or finer; where a rect was loaded coarser (the user zoomed in), it requests that area with `maxSize` = the old `minSize`, fetching just the elements the coarser load skipped. Incoming elements go through the version rule. Elements beyond 3× the viewport are evicted unless selected or being edited, and evicting them shrinks the loaded rects to match.
- **Op writer**: local changes become full `element` records with the held version as `baseSeq` and the changed field paths, one frame in flight at a time (see Conflicts). Editing a shape also rewrites the connectors that reference it in the same frame, so their bboxes stay true and land atomically; the client holds them, because every load returns referencing elements with what they reference.
- **Undo**: stores, per op, the previous values of only the fields it changed. Undoing writes the current element with those fields restored, as a new op. Remote edits to other fields survive; a field another user changed since is left as it is, as `Y.UndoManager` does today.

The client never assumes it holds every element:

- **Fit to content, minimap**: use the manifest's `bounds`, sent in `CanvasJoined` and updated with each `CanvasFlushed`.
- **Select all, search**: query the server.
- **Moving a section**: loads the section's bbox first, so contained elements are present.
- **Connectors**: load off-view endpoints with `ids=`.

## Levels of detail

Zoomed out far enough, the viewport covers the whole board. `minSize` keeps sub-pixel elements off the wire, which is enough for most boards. A second phase adds simplified records for strokes (down-sampled points) and placeholder records for media, referenced from internal index nodes, if large boards still load too much when zoomed out. The record kinds leave room for this, so it needs no format version bump.

## Other consumers

- **Revisions**: the revision `snapshot` holds the manifest (base + segment keys), not JSON; taking one flushes the working set first, so it covers every broadcast op. Restore discards the pending buffer and writes a manifest with the revision's base and segments, `seq` and `floor` both set to the working set's `seq` + 1 (not the manifest's, which can lag behind ops clients already hold). It starts a new epoch, rebuilds the segment map from the restored segments, and broadcasts `CanvasReload` with the new epoch and `seq`. `seq` never moves backwards, so every restored element is newer than anything a client holds. Clients drop their state, their pending fields and every op kept for resending, then reload. Unlike after a crash, nothing is rebased: the restore replaces the document, and edits built on the replaced state are discarded deliberately, both unflushed ones and those in flight, which the old epoch rejects. GC keeps every blob a revision references.
- **Agent edits**: replace the JSON edit path in `#realtime/yjsRooms.ts` (`syncCanvasCollection`) with a load query plus `CanvasOps` submitted by the server. Agent presence is unchanged.
- **Search, export, templates**: stream the full document through the decoder.
- **Cloudflare**: the blob store is R2 (range reads supported, multipart uploads for `putStream`), and the working set lives in the space's Durable Object.
  - Memory: all open canvases of a space share the object's 128 MB. A working set holds only the segment map (bounded by the segment tunables below) and pending records; a base rewrite holds about 60 bytes per element (6 MB at 100k). Working sets of canvases without room members are flushed and closed.
  - Compaction: there is no serializer worker, so it runs from the object's alarm, one document at a time. Both tiers are streaming and wait mostly on R2. Whether a base rewrite of the largest boards fits one alarm invocation is an open question.
  - Eviction flushes, and hibernation is handled by the epoch in `CanvasOps` (see Durability).

## Tunables

Starting values, to be checked against the 100k board test and a replay of a recorded editing session (see Testing).

| Tunable | Value | Bounds |
|---|---|---|
| Flush debounce | 1 s | edits lost on a crash from a client that is gone too |
| Flush size | 64 KB | the pending buffer |
| Segment merge | > 32 segments | range reads per load and the time to open a canvas |
| Base rewrite | segments > 25% of the base, ≥ 1 MB | write amplification: a base is rewritten at most once per quarter of its size in edits |
| GC age | 1 h | must exceed the longest write-to-commit gap of a flush or compaction |
| Region padding, eviction | 50%, 3× | requests while panning against client memory |
| Index node size | 16 | index levels against bytes read per node |
| Point quantization | 16 per world unit | stroke size against precision at high zoom |

## Removed

- `seedCanvasDoc`, `withPinnedYjsSeed`, `parseCanvasContent` and `mapSnapshotFromDoc`.
- The `map-snapshot` format in `#documents/serialization.ts` and its rooms in `#realtime/yjsRooms.ts`.
- The 5 s persist throttle and large-payload brotli quality for canvases.
- The content spill path for canvases.

## Migration

One cutover. On first open (or a one-shot migration over all spaces), stream the JSON snapshot into a base file and write the manifest. Existing canvas revisions are converted the same way, each to its own base, and the pre-migration snapshot is kept as one more converted revision. No dual read path afterwards.

Strokes have no `z` today and render in `updatedAt` order (`syncStrokesFromY`). Migration assigns their `z` from that order, and connectors get `refs` from their endpoints.

## Module layout

Following the canvas layering (`geometry → render/input → document → …`), the format lives in `#canvas/document/format/` and is imported by both client and server:

- `values.ts`: tagged values and varints.
- `records.ts`: record encode/decode, including stroke points.
- `hilbert.ts`, `rtree.ts`: index build and query.
- `lookup.ts`: the `ids` and `refs` tables.
- `stream.ts`: incremental decoder over a `ReadableStream<Uint8Array>`.

The server side (manifest, flush, compaction, query) lives in `#db/space/canvasStore.ts`, and the room in `#realtime/canvasRooms.ts`.

## Testing

Integration level only:

- Round-trip a real canvas through migration → load → edit → compaction → load and compare rendered snapshots.
- The walkthrough above, scripted with three browser clients, asserting the final state and that frame 1, the recolour and frame 2 are never rejected.
- Two browser clients editing the same field of one shape concurrently; both converge.
- A drag over a socket with 100 ms added latency: no frame is rejected, and the final position lands.
- A recolour from a client with 300 ms latency while another client drags the same shape: it lands without a rejection.
- Panning while another client moves and deletes elements across the edge of the requested region: no element comes back in its old state.
- Moving a shape whose connector's other end is off-view: the connector is loaded with the shape and lands with it.
- A client disconnecting with a rejected op pending, then reconnecting: the op is rebased and lands.
- A server restart between broadcast and flush: connected clients see a new epoch, reload, and their unflushed edits land.
- A revision restore while another client has an edit in flight: the edit is discarded, the client reloads the restored state, and its next edit lands.
- Deleting a shape with a connector attached, while another client creates a second connector to it: the first connector is rewritten in the delete frame, the second dangles and renders as its type decides.
- An edit from a stale client to an element deleted before a compaction is rejected.
- Loading zoomed out, then zooming in over the same region: the small elements arrive, the large ones are not fetched twice.
- A viewport load that asserts only intersecting ids arrive.
- A large generated board (100k strokes) that checks load time and server memory against today.

## Open questions

- Whether `minSize` alone is enough at zoom-out on real boards, or the simplified-record phase is needed from the start.
- The quantization scale for stroke points (1/16 world unit assumed) against existing drawings at high zoom.
- Whether a base rewrite of the largest boards fits one Durable Object alarm invocation, or needs to resume across several.
- Whether the region loader should send its loaded rects so the server can subtract them, instead of the client computing uncovered areas.
- Whether the server should recompute `bbox` for shapes and strokes with the shared geometry code. A client geometry bug otherwise leaves an element reachable only by a full load; text still needs the client's layout.
