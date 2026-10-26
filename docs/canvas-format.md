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

- A segment's records are consecutive from the `firstSeq` in its name.
- A live `CanvasOps` frame carries its first `seq`; its records are consecutive from there.
- Base records and restored files carry no individual version: everything in them is at the manifest's `floor` (below).
- A load response starts with a `cursor`, and every element in it is current to at least that `seq`, so the client holds it at version `cursor`.

`seq` restarts from the manifest after a server restart, so it is only comparable within one **epoch**: a random id the server picks when it opens a canvas's working set. Cursors are `(epoch, seq)`.

### Record kinds

| Kind | Name | Where | Payload |
|---|---|---|---|
| `0x01` | `header` | first record of a base | element count u32, document bounds (4×f32), offset and length of `index` and `ids` (4×u64, absolute file offsets) |
| `0x02` | `index` | base | packed Hilbert R-tree (below) |
| `0x03` | `ids` | base | id lookup table (below) |
| `0x10` | `element` | anywhere | one complete element (below) |
| `0x11` | `delete` | segments, live ops | `id` |
| `0x20` | `cursor` | load responses | `epoch` string, `seq` varint: the snapshot the response is consistent to |

The header is fixed-width so its offsets do not depend on their own encoded length. The format version is the preamble's `version` byte alone.

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
| `body` | tagged value (below) |

The fixed fields come first, so the index builder and viewport filter never decode `body`.

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

### `index`

A packed Hilbert R-tree, as in FlatGeobuf. Elements in a base are sorted by the Hilbert value of their bbox centre, which also makes elements close on the canvas close in the file. The tree is stored root-first; node size is 16. Each node entry is 4×f32 bbox plus a u32 offset: a child node index for internal entries, a byte offset of the `element` record for leaves (≈ 20 bytes per element).

A query walks the tree with the viewport and returns leaf offsets, which collapse into a few contiguous byte ranges thanks to the Hilbert order.

### `ids`

Fixed-width entries sorted by key, so a lookup is a binary search over range reads: `hash u64 | recordOffset u64`, where `hash` is the first 8 bytes of SHA-256 of the id. On a hash match the reader decodes the record and compares the full id, continuing over neighbouring entries with the same hash.

### Base file order

```
magic | header | index | ids | element × n (Hilbert order)
```

The index precedes the elements, so a reader holding the header and index can range-read just the elements it needs. A base never contains `delete` records or duplicate ids.

## Storage

Per document, under the existing `documents/<id>/` blob prefix:

- `base-<uuid>.vcanvas` — the last compaction.
- `seg-<seq>.vcanvas` — ordered segments since then: `element` and `delete` records, no index.

The manifest replaces the JSON snapshot in `document.content` (a few hundred bytes, never spilled):

```json
{
  "format": "vcanvas",
  "base": "base-….vcanvas",
  "segments": ["seg-1042.vcanvas", …],
  "seq": 1107,
  "floor": 1041,
  "bounds": [x0, y0, x1, y1]
}
```

- `seq`: the last flushed `seq`.
- `floor`: the version of every element whose latest record is not in a segment after it — the last compaction's `seq`, or the restore's (see Revisions). Segments in the list with `firstSeq` ≤ `floor` are history a restore brought back and count as part of the floor.
- `bounds`: a superset of the document bounds. Flushes grow it; compaction makes it exact again. The header's bounds are only valid for the base.

The row write is the commit point, as for spilled content today. Blobs no manifest or revision references are garbage.

## Writing

The server keeps one working set per open canvas: its `epoch`, the `seq` counter, `floor`, the records not yet flushed, and the **segment map** `id → (version, bbox, file, offset, deleted)` for every record in the listed segments and the pending buffer. Opening a canvas builds the map by streaming the segments once; an entry's version is its record's `seq` raised to at least `floor`, so records from restored history count as `floor`. The map is bounded by compaction and holds no payloads; the server never holds elements.

Edits are a compare-and-set per element:

1. A client sends a `CanvasOps` frame: an `opId`, and `element`/`delete` records each paired with a `baseSeq` — the version of the element it edited from, or `0` for a create.
2. The server checks write access and readonly, and decodes the fixed fields for well-formedness and size limits (it does not interpret `body`).
3. It checks every record against the element's current version, `map[id].version` or else `floor`. A record is accepted when `baseSeq` ≥ that version. A create (`baseSeq` 0) is always accepted: ids are client-generated UUIDs.
4. The frame is atomic. If any record fails, the whole frame is rejected with `CanvasReject` (`opId`, the failing ids), and nothing is assigned or broadcast. A shape and the connectors it rewrites therefore land together or not at all.
5. Otherwise each record gets the next `seq`, updates the segment map, is appended to the pending buffer, and the frame is broadcast to the room, the sender included, carrying its `opId`.
6. A flush (1 s debounce, or 64 KB pending, or the last client leaving) writes the pending records as `seg-<firstSeq>.vcanvas`, updates the manifest (`seq`, `segments`, `bounds`), and then broadcasts `CanvasFlushed` with the flushed `seq`.

An edit to a deleted element fails the check, because the tombstone's version is above any `baseSeq` held from before the delete. After compaction drops the tombstone, the check falls back to `floor`, which is above it too. Deleted elements cannot be resurrected by stale clients.

### Durability

Clients see ops at broadcast, before they are durable. A sender keeps every op until a `CanvasFlushed` covers its `seq`, not just until the echo arrives.

A server restart loses the unflushed records and opens a new working set with a new `epoch`, continuing from the manifest's `seq`. A reconnecting client compares epochs. On a change, it discards its loaded state, reloads its region, rebases every op not covered by a `CanvasFlushed` onto the reloaded elements (as on a rejection; a create whose id now exists becomes an edit of it), and resends. An op that was in fact flushed just before the crash rebases to a no-op change. Nothing a connected client wrote is lost; ops from a client that is gone too are lost, at most one flush interval.

### Compaction

Triggered when segments exceed 1 MB total or 32 files; runs in the serializer worker, one at a time per document. It covers the segments present when it starts (up to `seq` S):

1. Stream base + segments, keeping only `id → (bbox, hilbert, latest record location, deleted)`. Memory is O(elements × ~60 bytes), never payloads.
2. Sort live ids by Hilbert value, compute record offsets, and build `index` and `ids`.
3. Stream the output through `putStream`: header, index, ids, then each latest record copied by range read from its source file.
4. Update the manifest to the new base plus the segments after S, with `floor` = S and exact `bounds`, conditional on `floor` being unchanged (a restore during compaction moves it and discards the result). Drop map entries with version ≤ S.

Segments flushed during compaction stay in the manifest untouched.

Compaction raises every folded element's version to S. The server then broadcasts `CanvasCompacted` with S, and clients raise every held version below S to S. That is sound because the socket is ordered: a client receiving it has already applied every op ≤ S, so its held elements are current to S. An op a client sent before receiving it fails the check once and is rebased like any other rejection.

## Loading

`GET /api/v1/spaces/:space/documents/:id/canvas` returns `application/vnd.vektor.canvas`:

| Query | Returns |
|---|---|
| `view=x0,y0,x1,y1` | elements whose bbox intersects the rect |
| `minSize=s` | additionally skips elements whose bbox is smaller than `s` world units in both axes |
| `maxSize=m` | additionally skips elements whose bbox is at least `m` world units in either axis |
| `ids=a,b,…` | the named elements, via the `ids` table |
| none | every element (export, agent, search indexing) |

The server reads the header and index with range reads (the top levels of hot indexes are cached in the working set) and resolves overrides with the segment map. It then streams:

1. A `cursor` record with the working set's `epoch` and current `seq`.
2. For each matching base element the map does not override, the base record, from its byte ranges via `readStream`.
3. For each matching live map entry, its record, from its segment by range read or from the pending buffer.

Each id appears at most once and no tombstones are sent. Responses carry no `header`, `index` or `ids`. Ops that land while the response streams can make an element newer than the cursor, never older: every element in a response is current to at least `cursor`, which is all the client relies on.

A base or segment a response is reading stays in the blob store until the response ends: GC deletes a blob only once no manifest, revision or open read references it.

### Join order

The client joins the room before loading, receives the room's `epoch`, and buffers live frames. Once the response's `cursor` arrives, it drops buffered ops with `seq` ≤ `cursor` and applies the rest in order, all through the version rule below. A response whose `epoch` differs from the room's is discarded and retried.

## Live protocol

New realtime frames, binary like the Yjs frames (`#realtime/protocol.ts`):

| Frame | Direction | Payload |
|---|---|---|
| `CanvasJoin` / `CanvasLeave` | client → server | `documentId` |
| `CanvasJoined` | server → client | `documentId`, `epoch`, `seq`, `bounds` |
| `CanvasOps` | client → server | `documentId`, `opId`, (`baseSeq`, record) pairs |
| `CanvasOps` | server → client | `documentId`, `opId`, first `seq`, records |
| `CanvasReject` | server → client | `documentId`, `opId`, failing ids — to the sender only |
| `CanvasFlushed` | server → client | `documentId`, flushed `seq`, `bounds` |
| `CanvasCompacted` | server → client | `documentId`, compaction `seq` |
| `CanvasReload` | server → client | `documentId`, `seq` — after a revision restore |

Every op goes to every room member, on one ordered socket per client. Clients apply every record for an element they hold, and ignore records for elements they do not hold unless the new bbox moves them into the loaded region. Presence stays on the existing presence rooms.

### Versions on the client

Every element a client holds carries its version: the `seq` of the op it came from, or the `cursor` of the response it came from. An incoming element or delete replaces held state only when its version is greater; equal versions are the same state.

A delete leaves a tombstone `id → seq` on the client, so a response that started before the delete cannot bring the element back. A tombstone is dropped once every region request that was outstanding when it arrived has finished.

### Conflicts

Records are whole elements, and the server's compare-and-set decides. To keep the per-field merge Yjs gives today, a client tracks its pending field edits per element: the fixed fields, and the entries of `body` and of a shape's `frame`, `style` and `data`. An op's fields are pending until its echo arrives; the op itself is kept for resending until `CanvasFlushed` covers it (see Durability).

On `CanvasReject`, the client takes the latest held version of each failing element (fetching it with `ids=` if it is not held), reapplies its pending fields on top, and resends the whole frame with the new `baseSeq`s. A remote record for an element with pending edits needs no immediate action: it is applied as is and shown with the pending fields layered on top, and the client's own in-flight op will be rejected and rebased.

Two users editing different fields of one shape both keep their change; editing the same field, the later accepted op wins. No client ever observes a record that drops another's accepted edit, because a record built on a stale version is never accepted.

## Client

The canvas controller replaces the Yjs `observeDeep` sync (`#canvas/runtime/controller.ts`) with:

- **Streaming decoder**: upserts elements into state as records arrive and requests a render per batch.
- **Region loader**: on viewport change, requests the viewport padded by 50%, and passes `minSize` = one screen pixel in world units. The loader records each loaded rect with the `minSize` it was loaded at. A request covers only what no loaded rect covers at that `minSize` or finer; where a rect was loaded coarser (the user zoomed in), it requests that area with `maxSize` = the old `minSize`, fetching just the elements the coarser load skipped. Incoming elements go through the version rule. Elements beyond 3× the viewport are evicted unless selected or being edited, and evicting them shrinks the loaded rects to match.
- **Op writer**: every local change emits full `element` records with the held version as `baseSeq`. Editing a shape also rewrites its attached connectors in the same frame, so their bboxes stay true and land atomically.
- **Undo**: stores, per op, the previous values of only the fields it changed. Undoing writes the current element with those fields restored, as a new op. Remote edits to other fields survive; a field another user changed since is left as it is, as `Y.UndoManager` does today.

The client never assumes it holds every element:

- **Fit to content, minimap**: use the manifest's `bounds`, sent in `CanvasJoined` and updated with each `CanvasFlushed`.
- **Select all, search**: query the server.
- **Moving a section**: loads the section's bbox first, so contained elements are present.
- **Connectors**: load off-view endpoints with `ids=`.

## Levels of detail

Zoomed out far enough, the viewport covers the whole board. `minSize` keeps sub-pixel elements off the wire, which is enough for most boards. A second phase adds simplified records for strokes (down-sampled points) and placeholder records for media, referenced from internal index nodes, if large boards still load too much when zoomed out. The record kinds leave room for this, so it needs no format version bump.

## Other consumers

- **Revisions**: the revision `snapshot` holds the manifest (base + segment keys), not JSON. Restore writes a manifest with the revision's base and segments, `seq` and `floor` both set to the current `seq` + 1, and broadcasts `CanvasReload` with it. `seq` therefore never moves backwards, every restored element is newer than anything a client holds, and the working set rebuilds its segment map from the restored segments. Clients drop their state and reload. GC keeps every blob a revision references.
- **Agent edits**: replace the JSON edit path in `#realtime/yjsRooms.ts` (`syncCanvasCollection`) with a load query plus `CanvasOps` submitted by the server. Agent presence is unchanged.
- **Search, export, templates**: stream the full document through the decoder.
- **Cloudflare**: the blob store is R2 (range reads supported), and the working set lives in the space's Durable Object.

## Removed

- `seedCanvasDoc`, `withPinnedYjsSeed`, `parseCanvasContent` and `mapSnapshotFromDoc`.
- The `map-snapshot` format in `#documents/serialization.ts` and its rooms in `#realtime/yjsRooms.ts`.
- The 5 s persist throttle and large-payload brotli quality for canvases.
- The content spill path for canvases.

## Migration

One cutover. On first open (or a one-shot migration over all spaces), stream the JSON snapshot into a base file, write the manifest, and keep the old JSON as a revision. No dual read path afterwards.

## Module layout

Following the canvas layering (`geometry → render/input → document → …`), the format lives in `#canvas/document/format/` and is imported by both client and server:

- `values.ts`: tagged values and varints.
- `records.ts`: record encode/decode, including stroke points.
- `hilbert.ts`, `rtree.ts`: index build and query.
- `stream.ts`: incremental decoder over a `ReadableStream<Uint8Array>`.

The server side (manifest, flush, compaction, query) lives in `#db/space/canvasStore.ts`, and the room in `#realtime/canvasRooms.ts`.

## Testing

Integration level only:

- Round-trip a real canvas through migration → load → edit → compaction → load and compare rendered snapshots.
- Two browser clients editing different fields, and the same field, of one shape concurrently; both converge and no accepted edit is lost.
- A client disconnecting with a rejected op pending, then reconnecting: the op is rebased and lands.
- A server restart between broadcast and flush: connected clients see a new epoch, reload, and their unflushed edits land.
- A revision restore followed by live edits and an edit from a client holding pre-restore state (rejected, then rebased).
- An edit from a stale client to an element deleted before a compaction is rejected.
- Loading zoomed out, then zooming in over the same region: the small elements arrive, the large ones are not fetched twice.
- A viewport load that asserts only intersecting ids arrive.
- A large generated board (100k strokes) that checks load time and server memory against today.

## Open questions

- Whether `minSize` alone is enough at zoom-out on real boards, or the simplified-record phase is needed from the start.
- The quantization scale for stroke points (1/16 world unit assumed) against existing drawings at high zoom.
- Whether the region loader should send its loaded rects so the server can subtract them, instead of the client computing uncovered areas.
