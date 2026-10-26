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

Two concatenated streams form a valid stream once the second's magic is dropped. A file is the log of everything written to it: for any element id, the last record wins.

### Record kinds

| Kind | Name | Where | Payload |
|---|---|---|---|
| `0x01` | `header` | first record of a base | element count, document bounds (4×f32), offset and length of `index` and `ids`, encoder version |
| `0x02` | `index` | base | packed Hilbert R-tree (below) |
| `0x03` | `ids` | base | sorted `(id, recordOffset)` pairs, for lookup by id |
| `0x10` | `element` | anywhere | one complete element (below) |
| `0x11` | `delete` | segments, live ops | `id`, `updatedAt` |
| `0x20` | `cursor` | load responses | the `seq` the response is current to |

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
{ "format": "vcanvas", "base": "base-….vcanvas", "segments": ["seg-1042.vcanvas", …], "seq": 1107 }
```

The row write is the commit point, as for spilled content today. Blobs no manifest or revision references are garbage.

## Writing

The server keeps one working set per open canvas: the `seq` counter and the records not yet flushed. It never holds elements.

1. A client sends `element`/`delete` records over the socket.
2. The server checks write access and readonly, decodes the fixed fields for well-formedness and size limits (it does not interpret `body`), assigns each record the next `seq`, appends it to the pending buffer, and broadcasts the same bytes to the room.
3. A flush (1 s debounce, or 64 KB pending, or the last client leaving) writes the pending records as `seg-<firstSeq>.vcanvas` and then updates the manifest.

A crash loses at most the unflushed second, as today.

### Compaction

Triggered when segments exceed 1 MB total or 32 files; runs in the serializer worker, one at a time per document. It covers the segments present when it starts (up to `seq` S):

1. Stream base + segments, keeping only `id → (bbox, hilbert, latest record location, deleted)`. Memory is O(elements × ~60 bytes), never payloads.
2. Sort live ids by Hilbert value, compute record offsets, and build `index` and `ids`.
3. Stream the output through `putStream`: header, index, ids, then each latest record copied by range read from its source file.
4. Update the manifest to the new base plus the segments after S, conditional on the base being unchanged.

Segments flushed during compaction stay in the manifest untouched.

## Loading

`GET /api/v1/spaces/:space/documents/:id/canvas` returns `application/vnd.vektor.canvas`:

| Query | Returns |
|---|---|
| `view=x0,y0,x1,y1` | elements whose bbox intersects the rect |
| `minSize=s` | additionally skips elements whose bbox is smaller than `s` world units in both axes |
| `ids=a,b,…` | the named elements, via the `ids` table |
| none | every element (export, agent, search indexing) |

The server reads the header and index with range reads (the top levels of hot indexes are cached in the working set), reads all segments and the pending buffer whole (bounded by compaction), and resolves them into `id → latest record`. It then streams:

1. A `cursor` record with the current `seq`.
2. Overridden or deleted base elements are skipped; for each matching base element, the base record otherwise, from its byte ranges via `readStream`.
3. Segment and pending elements matching the query.

Each id appears at most once and no tombstones are sent. Responses carry no `header`, `index` or `ids`.

### Join order

The client joins the room before loading and buffers live ops, then drops buffered ops with `seq` ≤ the response's `cursor`. This keeps load and live ops gap-free without locking.

## Live protocol

New realtime frames, binary like the Yjs frames (`#realtime/protocol.ts`):

| Frame | Direction | Payload |
|---|---|---|
| `CanvasJoin` / `CanvasLeave` | client → server | `documentId` |
| `CanvasOps` | client → server | `documentId`, records |
| `CanvasOps` | server → client | `documentId`, first `seq`, records |
| `CanvasReload` | server → client | `documentId` — after a revision restore |

Every op goes to every room member. Clients ignore records for elements outside their loaded region, unless the new bbox moves them into it. Presence stays on the existing presence rooms.

### Conflicts

Records are whole elements, and the server's order decides. To keep the per-field merge Yjs gives today, a client tracks its pending (unacknowledged) field edits per element. When a remote record arrives for such an element, it reapplies its pending fields on top and resends. Two users editing different fields of one shape both keep their change; editing the same field, the later one wins.

## Client

The canvas controller replaces the Yjs `observeDeep` sync (`#canvas/runtime/controller.ts`) with:

- **Streaming decoder**: upserts elements into state as records arrive and requests a render per batch.
- **Region loader**: on viewport change, requests the viewport padded by 50%, minus strips already loaded, and passes `minSize` = one screen pixel in world units. Elements are deduplicated by `updatedAt`. Elements beyond 3× the viewport are evicted unless selected or being edited.
- **Op writer**: every local change emits full `element` records. Editing a shape also rewrites its attached connectors, so their bboxes stay true.
- **Undo**: stores the previous records of each op and replays them as new ops.

The client never assumes it holds every element:

- **Fit to content, minimap**: use the header bounds.
- **Select all, search**: query the server.
- **Moving a section**: loads the section's bbox first, so contained elements are present.
- **Connectors**: load off-view endpoints with `ids=`.

## Levels of detail

Zoomed out far enough, the viewport covers the whole board. `minSize` keeps sub-pixel elements off the wire, which is enough for most boards. A second phase adds simplified records for strokes (down-sampled points) and placeholder records for media, referenced from internal index nodes, if large boards still load too much when zoomed out. The record kinds leave room for this, so it needs no format version bump.

## Other consumers

- **Revisions**: the revision `snapshot` holds the manifest (base + segment keys), not JSON. Restore sets the manifest and broadcasts `CanvasReload`. GC keeps every blob a revision references.
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
- Two browser clients editing the same shape concurrently.
- A viewport load that asserts only intersecting ids arrive.
- A large generated board (100k strokes) that checks load time and server memory against today.

## Open questions

- Whether `minSize` alone is enough at zoom-out on real boards, or the simplified-record phase is needed from the start.
- The quantization scale for stroke points (1/16 world unit assumed) against existing drawings at high zoom.
- Whether the region loader should send its loaded rects so the server can subtract them, instead of the client deduplicating.
