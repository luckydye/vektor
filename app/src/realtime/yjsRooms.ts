import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import * as Y from "yjs";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument, getDocumentContent, updateDocument } from "#db/space/documents.ts";
import { createRevision, getLatestRevisionCreatedAt } from "#db/space/revisions.ts";
import type { EditOperation } from "#documents/edit.ts";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml, nodeToHtml } from "#documents/schema/render.ts";
import type { DocNode } from "#documents/schema/specs.ts";
import { fragmentToNodes } from "#documents/schema/yDecode.ts";
import { applyDocToFragment, docNodesToY } from "#documents/schema/yEncode.ts";
import {
  type CollaborationContentFormat,
  contentFromDoc,
  docNodeFromContent,
  mapSnapshotFromDoc,
  toCleanHtml,
} from "#documents/serialization.ts";
import {
  deserializeDocContent,
  serializeDocContent,
} from "#documents/serializationPool.ts";
import { documentIsReadonly } from "#documents/types.ts";
import { appLogger } from "#observability/logger.ts";
import { traced, tracedSync } from "#observability/trace.ts";
import { sanitizeDocumentHtml } from "#utils/html.ts";
import {
  type PresenceEnvelope,
  type PresenceUser,
  WsMsgType,
  wsEncode,
  wsEncodeYjsUpdate,
} from "./protocol.ts";

export interface YRoom {
  /** Changes whenever persisted content is rebuilt into a new transient Y.Doc. */
  generation: string;
  doc?: Y.Doc;
  /** In-flight `loadYDoc` for a room that has no doc yet; see `ensureRoomDoc`. */
  loading?: Promise<Y.Doc>;
  clients: Set<WebSocket>;
  presences: Map<string, PresenceEnvelope>;
  writeBlocked?: boolean;
  /** Timestamp (ms) of the last persist attempt, used to throttle serialize frequency. */
  lastPersistAt?: number;
  /** User who made the most recently received collaborative update. */
  lastEditorId?: string;
  idleSince?: number;
}

export const yRooms = new Map<string, YRoom>();

const knownCollaborationContentFormats: Readonly<
  Record<string, CollaborationContentFormat>
> = {
  app: "source-code",
  canvas: "map-snapshot",
  workflow: "source-code",
};

function collaborationContentFormat(
  type: string | null | undefined,
): CollaborationContentFormat {
  return knownCollaborationContentFormats[type ?? ""] ?? "html";
}

export function roomKey(spaceId: string, documentId: string): string {
  return `${spaceId}:${documentId}`;
}

function splitRoomKey(key: string): { spaceId: string; documentId: string } | null {
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  return {
    spaceId: key.slice(0, separator),
    documentId: key.slice(separator + 1),
  };
}

export async function loadYDoc(spaceId: string, documentId: string): Promise<Y.Doc> {
  const meta = await getDocument(await openSpaceStore(spaceId), documentId);
  if (!meta) return new Y.Doc();
  const content = await getDocumentContent(await openSpaceStore(spaceId), documentId);
  if (!content) return new Y.Doc();
  // Off-thread: parsing a large document (HTML → ProseMirror → Yjs) blocks the
  // event loop and spikes memory; the pool falls back to in-process on failure.
  return traced("loadYDoc", () =>
    deserializeDocContent(collaborationContentFormat(meta.type), content),
  );
}

/**
 * The room's document, deserializing it once for however many joins arrive
 * while that is in flight. Switching documents sends two joins in the same
 * tick, and each would otherwise pay the full off-thread deserialize and then
 * overwrite the doc the other had already handed out and applied updates to.
 */
export async function ensureRoomDoc(spaceId: string, documentId: string): Promise<Y.Doc> {
  const room = getRoom(spaceId, documentId);
  if (room.doc) return room.doc;

  room.loading ??= loadYDoc(spaceId, documentId).finally(() => {
    room.loading = undefined;
  });
  const doc = await room.loading;
  // Re-read: the room can be dropped while the load runs, and the doc has to
  // land on the one that is registered now or its updates go nowhere.
  const current = getRoom(spaceId, documentId);
  current.doc ??= doc;
  return current.doc;
}

export function getRoom(spaceId: string, documentId: string): YRoom {
  const key = roomKey(spaceId, documentId);
  let room = yRooms.get(key);
  if (!room) {
    room = {
      generation: randomUUID(),
      clients: new Set(),
      presences: new Map(),
    };
    yRooms.set(key, room);
  }
  return room;
}

export function setYRoomWriteBlocked(
  spaceId: string,
  documentId: string,
  blocked: boolean,
): boolean {
  const room = yRooms.get(roomKey(spaceId, documentId));
  if (!room) return false;
  const previous = room.writeBlocked ?? false;
  room.writeBlocked = blocked;
  return previous;
}

/**
 * Diffs an edited item list into a canvas Y.Map collection (keyed by item id),
 * so only actual changes produce Yjs updates. Items without a string id are
 * ignored. Must run inside a transaction.
 */
function syncCanvasCollection(target: Y.Map<Y.Map<unknown>>, items: unknown): void {
  const toYValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(toYValue);
    if (!value || typeof value !== "object") return value;
    const map = new Y.Map<unknown>();
    for (const [key, child] of Object.entries(value)) map.set(key, toYValue(child));
    return map;
  };
  const comparable = (value: unknown) =>
    value instanceof Y.Map || value instanceof Y.Array ? value.toJSON() : value;
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(items)) {
    for (const item of items) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string"
      ) {
        byId.set((item as { id: string }).id, item as Record<string, unknown>);
      }
    }
  }

  for (const id of [...target.keys()]) {
    if (!byId.has(id)) target.delete(id);
  }

  for (const [id, item] of byId) {
    let map = target.get(id);
    if (!(map instanceof Y.Map)) {
      map = new Y.Map<unknown>();
      target.set(id, map);
    }
    for (const [key, value] of Object.entries(item)) {
      if (key === "id" || value === undefined) continue;
      if (JSON.stringify(comparable(map.get(key))) !== JSON.stringify(value)) {
        map.set(key, toYValue(value));
      }
    }
    for (const key of [...map.keys()]) {
      // `in` would see inherited keys, so a key named after an `Object.prototype`
      // member (`__proto__`, `toString`, ...) always looked present and was never
      // deleted — a removal on the wire silently no-op'd on the live document.
      if (!Object.hasOwn(item, key)) map.delete(key);
    }
  }
}

function isJsonContent(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-serializes persisted HTML to one top-level block per line (documents are
 * often stored as a single compact line), so line-based edits and reads use
 * the same deterministic line structure as the live-room path. Returns the
 * input unchanged if it cannot be parsed.
 */
function normalizeHtmlContent(content: string): string {
  if (!content.trim()) return content;
  try {
    return docToHtml(htmlToDoc(content));
  } catch {
    return content;
  }
}

/**
 * Returns the document content as edit operations see it: the live Yjs room
 * state when one is open, otherwise the persisted content. HTML is normalized
 * to one top-level block per line; app source, canvas snapshots, and workflow
 * source stay in their native serialized formats.
 */
export function getLiveDocumentContent(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
  persisted: string,
): string {
  const format = collaborationContentFormat(type);
  const room = yRooms.get(roomKey(spaceId, documentId));
  if (room?.doc) {
    if (format === "map-snapshot") return JSON.stringify(mapSnapshotFromDoc(room.doc));
    if (format === "source-code") return contentFromDoc(format, room.doc);
    return toCleanHtml(room.doc);
  }
  if (format !== "html" || isJsonContent(persisted)) return persisted;
  return normalizeHtmlContent(persisted);
}

/**
 * The write counterpart of `getLiveDocumentContent`: overwrites an open room
 * with `content` and broadcasts the change, so connected editors converge on it
 * instead of keeping — and later persisting — the state it replaced.
 *
 * Unlike the agent edit path this replaces wholesale rather than splicing the
 * changed blocks: the callers are deliberate resets (publishing an older
 * revision), where concurrent edits to the content being reset are what should
 * lose. Returns false when no room is open, leaving the stored content as the
 * only state.
 */
export function replaceLiveDocumentContent(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
  content: string,
): boolean {
  const room = yRooms.get(roomKey(spaceId, documentId));
  if (!room?.doc) return false;

  const doc = room.doc;
  const format = collaborationContentFormat(type);
  const updates: Uint8Array[] = [];
  const captureUpdate = (update: Uint8Array) => updates.push(update);

  doc.on("update", captureUpdate);
  try {
    doc.transact(() => {
      if (format === "map-snapshot") {
        const snapshot = JSON.parse(content) as { shapes?: unknown; strokes?: unknown };
        syncCanvasCollection(
          doc.getMap<Y.Map<unknown>>("canvas.shapes"),
          snapshot.shapes,
        );
        syncCanvasCollection(
          doc.getMap<Y.Map<unknown>>("canvas.strokes"),
          snapshot.strokes,
        );
        return;
      }
      applyDocToFragment(
        doc.getXmlFragment("default"),
        docNodeFromContent(format, content),
      );
    }, "server-edit");
  } finally {
    doc.off("update", captureUpdate);
  }

  for (const update of updates) {
    broadcastToRoom(room, wsEncodeYjsUpdate(documentId, update));
  }
  return true;
}

function broadcastToRoom(room: YRoom, frame: Uint8Array): void {
  for (const client of room.clients) {
    if (client.readyState === 1) {
      client.send(frame);
    }
  }
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 1000;
const COLLABORATION_REVISION_INTERVAL_MS = 3 * 60 * 60 * 1000;
// Serializing a large canvas (tens of MB JSON.stringify) blocks the event loop
// for ~100ms+, so cap how often it runs during sustained editing. Clean
// disconnects still flush via persistYRoomDraftBestEffort in the close handler.
const MIN_PERSIST_INTERVAL_MS = 5000;

export async function persistYRoomDraft(key: string): Promise<void> {
  const timer = persistTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(key);
  }

  const ids = splitRoomKey(key);
  if (!ids) return;

  const room = yRooms.get(key);
  if (!room?.doc) return;

  room.lastPersistAt = Date.now();

  // Metadata only — serializing the live room already yields the content to
  // save, so we never load the stored content here (previously getDocument
  // pulled the whole content column, tens of MB, on every debounce tick).
  // Persist only ever schedules after a real Yjs update and is throttled, so we
  // just write; no dedup read/hash needed.
  const meta = await getDocument(await openSpaceStore(ids.spaceId), ids.documentId);
  if (!meta) return;

  if (documentIsReadonly(meta)) {
    appLogger.info("Skipped persisting a readonly document from its live room", {
      spaceId: ids.spaceId,
      documentId: ids.documentId,
    });
    return;
  }

  const doc = room.doc;
  const format = collaborationContentFormat(meta.type);
  const serialized = await traced("persist.serialize", () =>
    serializeDocContent(format, doc),
  );
  const content = format === "html" ? sanitizeDocumentHtml(serialized) : serialized;

  const store = await openSpaceStore(ids.spaceId);
  // Unconditional: the room is the authority on this content, not a writer
  // racing one. Note that it still moves the document's sequence — a document
  // with an open editor changes every debounce, and any reader or API writer
  // holding a tag for it is genuinely looking at a stale document.
  await traced("persist.write", () =>
    updateDocument(store, ids.documentId, content, meta.type),
  );

  // Rich-text collaboration owns periodic checkpoint history. Serialized
  // collaboration persists drafts without creating a revision per Yjs update.
  if (format !== "html" || !room.lastEditorId) return;

  const latestRevisionCreatedAt = await getLatestRevisionCreatedAt(
    await openSpaceStore(ids.spaceId),
    ids.documentId,
  );
  const revisionIsDue =
    !latestRevisionCreatedAt ||
    Date.now() - latestRevisionCreatedAt.getTime() >= COLLABORATION_REVISION_INTERVAL_MS;
  if (!revisionIsDue) return;

  await createRevision(
    await openSpaceStore(ids.spaceId),
    ids.documentId,
    content,
    room.lastEditorId,
    {
      message: "Collaboration checkpoint",
      kind: "checkpoint",
    },
  );
}

/** Persists a room from a fire-and-forget lifecycle hook without leaking a rejection. */
export function persistYRoomDraftBestEffort(key: string): void {
  void settledPersist(key);
}

function settledPersist(key: string): Promise<void> {
  return persistYRoomDraft(key).catch((error) => {
    appLogger.warn("Failed to persist realtime room draft", { error, roomKey: key });
  });
}

function positiveDurationFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ROOM_GRACE_MS = positiveDurationFromEnv("VEKTOR_YJS_ROOM_GRACE_MS", 10 * 60 * 1000);
const MAX_IDLE_ROOMS = 200;
const ROOM_SWEEP_INTERVAL_MS = positiveDurationFromEnv(
  "VEKTOR_YJS_ROOM_SWEEP_INTERVAL_MS",
  60 * 1000,
);

function roomIsIdle(room: YRoom): boolean {
  return room.clients.size === 0 && room.presences.size === 0 && !room.loading;
}

export function sweepIdleYRooms(now = Date.now()): number {
  const idle: Array<{ key: string; idleSince: number }> = [];
  for (const [key, room] of yRooms) {
    if (!roomIsIdle(room)) {
      room.idleSince = undefined;
      continue;
    }
    if (room.idleSince === undefined) room.idleSince = now;
    idle.push({ key, idleSince: room.idleSince });
  }

  let dropped = 0;
  for (const { key, idleSince } of idle) {
    if (now - idleSince >= ROOM_GRACE_MS) {
      yRooms.delete(key);
      dropped++;
    }
  }

  const surviving = idle
    .filter(({ key }) => yRooms.has(key))
    .sort((a, b) => a.idleSince - b.idleSince);
  for (const { key } of surviving.slice(
    0,
    Math.max(0, surviving.length - MAX_IDLE_ROOMS),
  )) {
    yRooms.delete(key);
    dropped++;
  }
  return dropped;
}

const roomSweep = setInterval(() => sweepIdleYRooms(), ROOM_SWEEP_INTERVAL_MS);
roomSweep.unref?.();

export function retireYRoom(key: string): void {
  void settledPersist(key).then(() => {
    const room = yRooms.get(key);
    if (!room || !roomIsIdle(room)) return;
    room.idleSince = Date.now();
    sweepIdleYRooms();
  });
}

export function scheduleYRoomDraftPersist(key: string, editorId?: string): void {
  const existing = persistTimers.get(key);
  if (existing) clearTimeout(existing);

  // Debounce quick bursts, but never persist more than once per
  // MIN_PERSIST_INTERVAL_MS — the serialize is the event-loop-blocking cost.
  const room = yRooms.get(key);
  if (editorId && room) {
    room.lastEditorId = editorId;
  }
  const sinceLast = room?.lastPersistAt
    ? Date.now() - room.lastPersistAt
    : Number.POSITIVE_INFINITY;
  const delay = Math.max(PERSIST_DEBOUNCE_MS, MIN_PERSIST_INTERVAL_MS - sinceLast);

  const timer = setTimeout(() => {
    persistTimers.delete(key);
    persistYRoomDraftBestEffort(key);
  }, delay);
  timer.unref?.();
  persistTimers.set(key, timer);
}

const AGENT_CLIENT_ID = "agent";
const AGENT_PRESENCE_USER: PresenceUser = {
  id: "agent",
  name: "Agent",
  color: "#8b5cf6",
};
const AGENT_PRESENCE_TTL_MS = 10_000;
const agentPresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearAgentPresence(key: string, documentId: string): void {
  agentPresenceTimers.delete(key);
  const room = yRooms.get(key);
  if (!room?.presences.has(AGENT_CLIENT_ID)) return;

  room.presences.delete(AGENT_CLIENT_ID);
  broadcastToRoom(
    room,
    wsEncode(WsMsgType.PresenceLeave, {
      room: documentId,
      clientId: AGENT_CLIENT_ID,
      timestamp: new Date().toISOString(),
    }),
  );

  if (room.clients.size === 0 && room.presences.size === 0) {
    retireYRoom(key);
  }
}

/**
 * Registers a presence for "Agent" in the room, broadcasts it, and arms a TTL
 * that removes it (refreshed by subsequent edits). Shared by the HTML and
 * canvas edit paths. Best-effort: failures are swallowed.
 */
function setAgentPresence(
  key: string,
  documentId: string,
  room: YRoom,
  state: unknown,
): void {
  try {
    const presence: PresenceEnvelope = {
      room: documentId,
      clientId: AGENT_CLIENT_ID,
      user: AGENT_PRESENCE_USER,
      state,
      updatedAt: new Date().toISOString(),
    };

    room.presences.set(AGENT_CLIENT_ID, presence);
    broadcastToRoom(room, wsEncode(WsMsgType.PresenceUpdate, { presence }));

    const existingTimer = agentPresenceTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(
      () => clearAgentPresence(key, documentId),
      AGENT_PRESENCE_TTL_MS,
    );
    timer.unref?.();
    agentPresenceTimers.set(key, timer);
  } catch {
    // Presence is cosmetic — never fail the edit over it.
  }
}

/**
 * Shows the "Agent" presence cursor spanning an explicit top-level block range
 * [anchorIndex, headIndex). Used by the incremental edit path, which knows the
 * changed range directly and so avoids serializing the whole doc to diff it.
 */
function broadcastAgentPresenceRange(
  key: string,
  documentId: string,
  room: YRoom,
  doc: Y.Doc,
  anchorIndex: number,
  headIndex: number,
): void {
  try {
    const fragment = doc.getXmlFragment("default");
    const clamp = (index: number) => Math.min(Math.max(index, 0), fragment.length);
    const toJson = (index: number) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(fragment, clamp(index)),
      );

    setAgentPresence(key, documentId, room, {
      kind: "editor",
      focused: true,
      selection: { anchor: toJson(anchorIndex), head: toJson(headIndex) },
    });
  } catch {
    // Presence is cosmetic — never fail the edit over it.
  }
}

type CanvasShapePosition = { id: string; x: number; y: number };

/**
 * Shows a presence cursor for "Agent" on a canvas, pointing at the shapes it
 * just added or changed (cursor parked at the last one, all of them selected),
 * mirroring the canvas client's own presence shape.
 */
function broadcastCanvasAgentPresence(
  key: string,
  documentId: string,
  room: YRoom,
  changed: CanvasShapePosition[],
): void {
  if (changed.length === 0) return;
  const last = changed.at(-1);
  if (!last) return;
  setAgentPresence(key, documentId, room, {
    kind: "canvas",
    pointer: { x: last.x, y: last.y },
    view: { x: last.x, y: last.y, scale: 1 },
    selectionIds: changed.map((shape) => shape.id),
    focusedNodeId: last.id,
    activeTool: null,
  });
}

/** Shapes added or changed between two canvas snapshots, with their positions. */
function changedCanvasShapes(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): CanvasShapePosition[] {
  const beforeById = new Map(
    before.map((shape) => [String(shape.id), JSON.stringify(shape)]),
  );
  const result: CanvasShapePosition[] = [];
  for (const shape of after) {
    const id = typeof shape.id === "string" ? shape.id : null;
    if (!id) continue;
    if (beforeById.get(id) === JSON.stringify(shape)) continue; // unchanged
    const frame =
      shape.frame && typeof shape.frame === "object"
        ? (shape.frame as Record<string, unknown>)
        : {};
    result.push({
      id,
      x: typeof frame.x === "number" ? frame.x : 0,
      y: typeof frame.y === "number" ? frame.y : 0,
    });
  }
  return result;
}

/**
 * Applies a content transform to a document through the collaboration channel.
 *
 * When the document has a live Yjs room, the current content is derived from
 * the room's Y.Doc, transformed, and applied back as an incremental Yjs update
 * that is broadcast to all connected clients — so the edit merges with
 * concurrent changes instead of overwriting them. Without a live room the
 * transform runs against the persisted content.
 *
 * Returns the resulting content (to be persisted by the caller), or null if
 * the document does not exist. Errors thrown by the transform propagate.
 */
/**
 * Detects edits that map to a positional splice of whole top-level blocks
 * without re-parsing the rest of the document. Only append (`insert` at `$`)
 * and prepend (`insert` at line `1`) qualify: they resolve to fragment index
 * `length`/`0` regardless of whether any existing block serializes to multiple
 * HTML lines (e.g. a code block with embedded newlines), which is the case
 * that makes arbitrary line→block mapping ambiguous. Everything else returns
 * null and takes the full round-trip, so behaviour is never worse than before.
 */
function asBlockSpliceInsert(
  operations: EditOperation[] | undefined,
): { position: "start" | "end"; content: string } | null {
  if (operations?.length !== 1) return null;
  const op = operations[0];
  if (op?.op !== "insert") return null;
  if (op.line === "$") return { position: "end", content: op.content };
  if (op.line === "1") return { position: "start", content: op.content };
  return null;
}

/**
 * Splices whole top-level blocks into the live fragment, replacing
 * `[from, from + remove)`, and shows the agent's presence over what it wrote.
 * Blocks outside the range keep their Yjs identity, so a human editing
 * elsewhere in the document keeps their concurrent changes.
 */
function spliceBlocks(
  spaceId: string,
  documentId: string,
  room: YRoom,
  doc: Y.Doc,
  from: number,
  remove: number,
  blocks: DocNode[],
  onUpdate: (update: Uint8Array) => void,
): void {
  const fragment = doc.getXmlFragment("default");
  const inserted = docNodesToY(blocks);

  doc.on("update", onUpdate);
  try {
    doc.transact(() => {
      if (remove > 0) fragment.delete(from, remove);
      if (inserted.length > 0) fragment.insert(from, inserted);
    }, "server-edit");
  } finally {
    doc.off("update", onUpdate);
  }

  broadcastAgentPresenceRange(
    roomKey(spaceId, documentId),
    documentId,
    room,
    doc,
    from,
    from + inserted.length,
  );
}

/**
 * Applies an append/prepend by parsing only the inserted content and splicing
 * the resulting blocks into the live fragment, so the cost is O(inserted
 * content) rather than O(document). Returns false if the insert produced no
 * blocks, so the caller can fall back to the full path.
 */
function applyBlockSpliceInsert(
  spaceId: string,
  documentId: string,
  room: YRoom,
  doc: Y.Doc,
  splice: { position: "start" | "end"; content: string },
  onUpdate: (update: Uint8Array) => void,
): boolean {
  const blocks = htmlToDoc(sanitizeDocumentHtml(splice.content)).content ?? [];
  if (blocks.length === 0) return false;

  const insertIndex =
    splice.position === "end" ? doc.getXmlFragment("default").length : 0;
  spliceBlocks(spaceId, documentId, room, doc, insertIndex, 0, blocks, onUpdate);
  return true;
}

/**
 * The range of top-level blocks that differ between the room's current content
 * and the transformed content, as `[from, remove, insert]`. Blocks are compared
 * by their serialized HTML, so an untouched block is recognised as untouched
 * however it was built.
 */
function changedBlockRange(
  before: string[],
  next: DocNode[],
): { from: number; remove: number; blocks: DocNode[] } {
  const after = next.map((node) => nodeToHtml(node));

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    from: prefix,
    remove: before.length - prefix - suffix,
    blocks: next.slice(prefix, after.length - suffix),
  };
}

export async function transformDocumentContent(
  spaceId: string,
  documentId: string,
  transform: (content: string) => string,
  operations?: EditOperation[],
): Promise<{ content: string; live: boolean } | null> {
  const dbDoc = await getDocument(await openSpaceStore(spaceId), documentId);
  if (!dbDoc) {
    return null;
  }

  if (documentIsReadonly(dbDoc)) {
    throw new Error("Cannot edit readonly document");
  }

  const format = collaborationContentFormat(dbDoc.type);

  const room = yRooms.get(roomKey(spaceId, documentId));
  if (!room?.doc) {
    const persisted =
      (await getDocumentContent(await openSpaceStore(spaceId), documentId)) ?? "";
    // Append/prepend splice at the very end/start, so they don't need the
    // content re-flowed to one-block-per-line — skip the normalize pass, which
    // is O(doc) and is what OOMs the process on large append-only logs edited
    // without a live room (e.g. the metrics-logger job). Other ops still
    // normalize so mid-document line references stay accurate.
    const skipNormalize =
      format !== "html" ||
      isJsonContent(persisted) ||
      asBlockSpliceInsert(operations) !== null;
    const base = skipNormalize ? persisted : normalizeHtmlContent(persisted);
    const transformed = transform(base);
    return {
      content: format === "html" ? sanitizeDocumentHtml(transformed) : transformed,
      live: false,
    };
  }

  if (room.writeBlocked) {
    throw new Error("Cannot edit readonly document");
  }

  const doc = room.doc;
  const updates: Uint8Array[] = [];
  const captureUpdate = (update: Uint8Array) => updates.push(update);

  if (format === "map-snapshot") {
    const nextRaw = transform(JSON.stringify(mapSnapshotFromDoc(doc), null, 2));
    let next: { shapes?: unknown; strokes?: unknown };
    try {
      next = JSON.parse(nextRaw) as { shapes?: unknown; strokes?: unknown };
    } catch {
      throw new Error("canvas edit must produce valid JSON");
    }
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error("canvas content must be an object with shapes and strokes");
    }

    const shapesBefore = mapSnapshotFromDoc(doc).shapes;

    doc.on("update", captureUpdate);
    try {
      doc.transact(() => {
        syncCanvasCollection(doc.getMap<Y.Map<unknown>>("canvas.shapes"), next.shapes);
        syncCanvasCollection(doc.getMap<Y.Map<unknown>>("canvas.strokes"), next.strokes);
      }, "server-edit");
    } finally {
      doc.off("update", captureUpdate);
    }

    for (const update of updates) {
      broadcastToRoom(room, wsEncodeYjsUpdate(documentId, update));
    }

    const shapesAfter = mapSnapshotFromDoc(doc).shapes;
    broadcastCanvasAgentPresence(
      roomKey(spaceId, documentId),
      documentId,
      room,
      changedCanvasShapes(shapesBefore, shapesAfter),
    );

    return { content: JSON.stringify(mapSnapshotFromDoc(doc)), live: true };
  }

  if (format === "source-code") {
    const transformed = transform(contentFromDoc(format, doc));

    doc.on("update", captureUpdate);
    try {
      doc.transact(() => {
        applyDocToFragment(
          doc.getXmlFragment("default"),
          docNodeFromContent(format, transformed),
        );
      }, "server-edit");
    } finally {
      doc.off("update", captureUpdate);
    }

    for (const update of updates) {
      broadcastToRoom(room, wsEncodeYjsUpdate(documentId, update));
    }

    return { content: contentFromDoc(format, doc), live: true };
  }

  // Fast path: append/prepend splices only the new blocks into the fragment,
  // so cost is O(inserted content) rather than O(document). Broadcast is the
  // same incremental Yjs update; only the return serialization stays O(n).
  const splice = asBlockSpliceInsert(operations);
  if (
    splice &&
    applyBlockSpliceInsert(spaceId, documentId, room, doc, splice, captureUpdate)
  ) {
    for (const update of updates) {
      broadcastToRoom(room, wsEncodeYjsUpdate(documentId, update));
    }
    return {
      content: await serializeDocContent(collaborationContentFormat(dbDoc.type), doc),
      live: true,
    };
  }

  // General path: transform the whole document, then splice only the top-level
  // blocks that actually changed. Granularity is a block rather than a
  // character — an agent editing one word replaces that paragraph, so a human
  // typing in the same paragraph at the same instant loses that edit — but
  // everything outside the changed range keeps its Yjs identity, and concurrent
  // edits to it survive.
  //
  // The current content is serialized here rather than through the pool: the
  // diff needs the per-block strings, and serializing is now a string walk with
  // no DOM behind it, which is what made the off-thread hop worth its cost.
  const currentBlocks = fragmentToNodes(doc.getXmlFragment("default")).map(nodeToHtml);
  const transformed = transform(currentBlocks.join("\n"));
  const nextHtml = format === "html" ? sanitizeDocumentHtml(transformed) : transformed;
  const { from, remove, blocks } = changedBlockRange(
    currentBlocks,
    htmlToDoc(nextHtml).content ?? [],
  );

  if (remove > 0 || blocks.length > 0) {
    spliceBlocks(spaceId, documentId, room, doc, from, remove, blocks, captureUpdate);
  }

  for (const update of updates) {
    broadcastToRoom(room, wsEncodeYjsUpdate(documentId, update));
  }

  return {
    content: await serializeDocContent(collaborationContentFormat(dbDoc.type), doc),
    live: true,
  };
}
