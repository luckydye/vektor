import * as Y from "yjs";
import { prosemirrorToYDoc, updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { generateHTML, generateJSON } from "@tiptap/html";
import { contentExtensions } from "../editor/extensions.ts";
import { getDocument } from "#db/documents.ts";
import {
  WsMsgType,
  wsEncode,
  wsEncodeYjsUpdate,
  type PresenceEnvelope,
  type PresenceUser,
} from "#utils/realtime.ts";

export interface YRoom {
  doc?: Y.Doc;
  clients: Set<any>;
  presences: Map<string, PresenceEnvelope>;
}

export const yRooms = new Map<string, YRoom>();

export function roomKey(spaceId: string, documentId: string): string {
  return `${spaceId}:${documentId}`;
}

type CanvasShape = {
  id: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
  src?: string;
  alt?: string;
  updatedAt?: number;
};

type CanvasStroke = {
  id: string;
  points?: unknown[];
  style?: Record<string, unknown>;
  updatedAt?: number;
};

function loadCanvasYDoc(content: string): Y.Doc {
  const ydoc = new Y.Doc();
  const shapes = ydoc.getMap<Y.Map<unknown>>("canvas.shapes");
  const strokes = ydoc.getMap<Y.Map<unknown>>("canvas.strokes");
  let parsed: { shapes?: CanvasShape[]; strokes?: CanvasStroke[] };

  try {
    parsed = JSON.parse(content) as { shapes?: CanvasShape[]; strokes?: CanvasStroke[] };
  } catch {
    return ydoc;
  }

  if (!Array.isArray(parsed.shapes) && !Array.isArray(parsed.strokes)) return ydoc;

  ydoc.transact(() => {
    for (const shape of parsed.shapes ?? []) {
      if (!shape || typeof shape.id !== "string") continue;
      const map = new Y.Map<unknown>();
      map.set("type", shape.type ?? "note");
      map.set("x", shape.x ?? 0);
      map.set("y", shape.y ?? 0);
      map.set("width", shape.width ?? 240);
      map.set("height", shape.height ?? 150);
      map.set("text", shape.text ?? "");
      map.set("color", shape.color ?? "#fef3c7");
      if (shape.src) map.set("src", shape.src);
      if (shape.alt) map.set("alt", shape.alt);
      map.set("updatedAt", shape.updatedAt ?? Date.now());
      shapes.set(shape.id, map);
    }

    for (const stroke of parsed.strokes ?? []) {
      if (!stroke || typeof stroke.id !== "string") continue;
      const map = new Y.Map<unknown>();
      map.set("points", Array.isArray(stroke.points) ? stroke.points : []);
      map.set("style", stroke.style ?? {});
      map.set("updatedAt", stroke.updatedAt ?? Date.now());
      strokes.set(stroke.id, map);
    }
  });

  return ydoc;
}

export async function loadYDoc(spaceId: string, documentId: string): Promise<Y.Doc> {
  const dbDoc = await getDocument(spaceId, documentId);
  if (!dbDoc?.content) return new Y.Doc();
  if (dbDoc.type === "canvas") return loadCanvasYDoc(dbDoc.content);

  const extensions = contentExtensions(spaceId, documentId);
  const json = generateJSON(dbDoc.content, extensions);
  const schema = getSchema(extensions);
  const pmDoc = Node.fromJSON(schema, json);
  return prosemirrorToYDoc(pmDoc, "default");
}

export function getRoom(spaceId: string, documentId: string): YRoom {
  const key = roomKey(spaceId, documentId);
  let room = yRooms.get(key);
  if (!room) {
    room = {
      clients: new Set(),
      presences: new Map(),
    };
    yRooms.set(key, room);
  }
  return room;
}

/**
 * Serializes the live Y.Doc to HTML with one top-level block per line, so
 * line-based edit operations have a deterministic line structure. The
 * server-side @tiptap/html build adds an xmlns attribute to elements; strip
 * it so the output matches client-produced content.
 */
function toCleanHtml(
  doc: Y.Doc,
  extensions: ReturnType<typeof contentExtensions>,
): string {
  const json = yDocToProsemirrorJSON(doc, "default") as {
    type: string;
    content?: unknown[];
  };
  return (json.content ?? [])
    .map((node) =>
      generateHTML({ type: json.type, content: [node] }, extensions).replaceAll(
        ' xmlns="http://www.w3.org/1999/xhtml"',
        "",
      ),
    )
    .join("\n");
}

/** Serializes a canvas room doc back to the snapshot content format. */
function canvasSnapshotFromDoc(doc: Y.Doc): {
  version: 1;
  shapes: Record<string, unknown>[];
  strokes: Record<string, unknown>[];
} {
  const collect = (name: string) =>
    [...doc.getMap<Y.Map<unknown>>(name).entries()].map(([id, map]) => ({
      id,
      ...(map instanceof Y.Map ? map.toJSON() : {}),
    }));
  return {
    version: 1,
    shapes: collect("canvas.shapes"),
    strokes: collect("canvas.strokes"),
  };
}

/**
 * Diffs an edited item list into a canvas Y.Map collection (keyed by item id),
 * so only actual changes produce Yjs updates. Items without a string id are
 * ignored. Must run inside a transaction.
 */
function syncCanvasCollection(target: Y.Map<Y.Map<unknown>>, items: unknown): void {
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
      if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
        map.set(key, value);
      }
    }
    for (const key of [...map.keys()]) {
      if (!(key in item)) map.delete(key);
    }
  }
}

/**
 * Returns the current content of a document's live Yjs room, or null when no
 * room is open (the persisted content is authoritative then).
 */
export function getLiveDocumentContent(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
): string | null {
  const room = yRooms.get(roomKey(spaceId, documentId));
  if (!room?.doc) return null;
  if (type === "canvas") return JSON.stringify(canvasSnapshotFromDoc(room.doc));
  return toCleanHtml(room.doc, contentExtensions(spaceId, documentId));
}

function broadcastToRoom(room: YRoom, frame: Uint8Array): void {
  for (const client of room.clients) {
    if (client.readyState === 1) {
      client.send(frame);
    }
  }
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
  if (!room || !room.presences.has(AGENT_CLIENT_ID)) return;

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
    yRooms.delete(key);
  }
}

/**
 * Shows a presence cursor for "Agent" spanning the top-level blocks that
 * changed between the two serialized contents, so other users see where the
 * agent edited. The presence is removed automatically after a short TTL
 * (refreshed by subsequent edits). Best-effort: failures are swallowed.
 */
function broadcastAgentPresence(
  key: string,
  documentId: string,
  room: YRoom,
  doc: Y.Doc,
  beforeHtml: string,
  afterHtml: string,
): void {
  try {
    if (beforeHtml === afterHtml) return;

    // Find the changed block range in the new content (common prefix/suffix).
    const oldLines = beforeHtml.split("\n");
    const newLines = afterHtml.split("\n");
    let prefix = 0;
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    ) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix++;
    }

    const fragment = doc.getXmlFragment("default");
    const anchorIndex = Math.min(prefix, fragment.length);
    const headIndex = Math.min(
      Math.max(newLines.length - suffix, anchorIndex),
      fragment.length,
    );

    const toJson = (index: number) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(fragment, index));

    const presence: PresenceEnvelope = {
      room: documentId,
      clientId: AGENT_CLIENT_ID,
      user: AGENT_PRESENCE_USER,
      state: {
        kind: "editor",
        focused: true,
        selection: {
          anchor: toJson(anchorIndex),
          head: toJson(headIndex),
        },
      },
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
export async function transformDocumentContent(
  spaceId: string,
  documentId: string,
  transform: (content: string) => string,
): Promise<{ content: string; live: boolean } | null> {
  const dbDoc = await getDocument(spaceId, documentId);
  if (!dbDoc) {
    return null;
  }

  const room = yRooms.get(roomKey(spaceId, documentId));
  if (!room?.doc) {
    return { content: transform(dbDoc.content ?? ""), live: false };
  }

  const doc = room.doc;
  const updates: Uint8Array[] = [];
  const captureUpdate = (update: Uint8Array) => updates.push(update);

  if (dbDoc.type === "canvas") {
    const nextRaw = transform(JSON.stringify(canvasSnapshotFromDoc(doc), null, 2));
    let next: { shapes?: unknown; strokes?: unknown };
    try {
      next = JSON.parse(nextRaw) as { shapes?: unknown; strokes?: unknown };
    } catch {
      throw new Error("canvas edit must produce valid JSON");
    }
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error("canvas content must be an object with shapes and strokes");
    }

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

    return { content: JSON.stringify(canvasSnapshotFromDoc(doc)), live: true };
  }

  const extensions = contentExtensions(spaceId, documentId);
  const schema = getSchema(extensions);

  const currentHtml = toCleanHtml(doc, extensions);
  const nextHtml = transform(currentHtml);
  const nextPmDoc = Node.fromJSON(schema, generateJSON(nextHtml, extensions));

  doc.on("update", captureUpdate);
  try {
    doc.transact(() => {
      updateYFragment(doc, doc.getXmlFragment("default"), nextPmDoc, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    }, "server-edit");
  } finally {
    doc.off("update", captureUpdate);
  }

  for (const update of updates) {
    broadcastToRoom(room, wsEncodeYjsUpdate(documentId, update));
  }

  const content = toCleanHtml(doc, extensions);
  broadcastAgentPresence(
    roomKey(spaceId, documentId),
    documentId,
    room,
    doc,
    currentHtml,
    content,
  );
  return { content, live: true };
}
