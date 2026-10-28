/**
 * Writing a whole snapshot JSON over a canvas, for the agent's canvas API and
 * document content writes: diffed into records and submitted like any
 * client's, by the server as a writer with its own clock.
 */

import * as Y from "yjs";
import { objectBounds } from "#canvas/agent/objectBounds.ts";
import { bodyMarkdown, writeBodyMarkdown } from "#canvas/document/bodyText.ts";
import {
  applyRecord,
  bodyDoc,
  type CanvasObject,
  createObject,
  type FlattenedItem,
  flattenShape,
  flattenStroke,
  objectDeleted,
  objectRefs,
} from "#canvas/document/format/object.ts";
import {
  createClock,
  readProperty,
  sameValue,
} from "#canvas/document/format/properties.ts";
import {
  type BBox,
  encodeObjectRecord,
  type PropertyGroup,
  type PropertyValue,
} from "#canvas/document/format/records.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  canvasWorkingSet,
  readAllCanvasObjects,
  readCanvasObjects,
} from "#db/space/canvasStore.ts";
import type { Platform } from "#platform/platform.ts";
import { canvasRoom, submitCanvasOps, waitForCanvasFlush } from "./canvasRooms.ts";

/** The server's writes: its own writer, one counter for every canvas it edits. */
const serverClock = createClock();

function flatten(item: Record<string, unknown>, kind: "shape" | "stroke"): FlattenedItem {
  return kind === "shape" ? flattenShape(item) : flattenStroke(item);
}

/**
 * Writes `next` over the canvas: changed keys, removed keys as `null`, new
 * objects whole, missing ones deleted, changed text as body updates. Returns
 * the ids it changed, once a flush covers them.
 */
export async function writeCanvasSnapshot(
  platform: Platform,
  spaceId: string,
  documentId: string,
  next: { shapes?: unknown; strokes?: unknown },
): Promise<string[]> {
  const store = await openSpaceStore(platform, spaceId);
  const ws = await canvasWorkingSet(store, documentId);
  const current = new Map(
    (await readAllCanvasObjects(ws)).map((object) => [object.id, object]),
  );
  const items = (value: unknown, kind: "shape" | "stroke") =>
    (Array.isArray(value) ? value : [])
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string",
      )
      .map((item) => flatten(item, kind));
  const wanted = [...items(next.shapes, "shape"), ...items(next.strokes, "stroke")];
  // Ids that exist only as deleted objects come back with a write that beats their delete.
  const revived = await readCanvasObjects(
    ws,
    wanted.filter((flat) => !current.has(flat.id)).map((flat) => flat.id),
  );

  const writes = new Map<
    string,
    { group: PropertyGroup | null; body: Uint8Array; full: boolean }
  >();
  const merged = new Map(current);
  for (const flat of wanted) {
    const existing = current.get(flat.id);
    const state = existing ?? revived.get(flat.id) ?? createObject(flat.id);
    const entries: [string, PropertyValue][] = existing
      ? flat.entries.filter(
          ([key, value]) => !sameValue(readProperty(existing.properties, key), value),
        )
      : [...flat.entries, ["deleted", false]];
    if (existing) {
      const kept = new Set(flat.entries.map(([key]) => key));
      for (const [key, entry] of existing.properties) {
        if (entry.value !== null && !kept.has(key) && key !== "deleted") {
          entries.push([key, null]);
        }
      }
    }
    let body: Uint8Array = new Uint8Array(0);
    const text = flat.text ?? "";
    if ((state.body ? bodyMarkdown(state.body) : "") !== text) {
      const doc = bodyDoc(state.body);
      const before = Y.encodeStateVector(doc);
      writeBodyMarkdown(doc, text);
      body = Y.encodeStateAsUpdate(doc, before);
    }
    if (entries.length === 0 && body.length === 0) continue;
    const group =
      entries.length > 0 ? { ...serverClock.next(state.properties), entries } : null;
    const after = createObject(flat.id);
    after.properties = new Map(state.properties);
    after.body = state.body;
    applyRecord(after, { groups: group ? [group] : [], body });
    merged.set(flat.id, after);
    writes.set(flat.id, { group, body, full: !existing });
  }
  const wantedIds = new Set(wanted.map((flat) => flat.id));
  for (const [id, object] of current) {
    if (wantedIds.has(id)) continue;
    const group = {
      ...serverClock.next(object.properties),
      entries: [["deleted", true]] as [string, PropertyValue][],
    };
    const after = createObject(id);
    after.properties = new Map(object.properties);
    applyRecord(after, { groups: [group], body: new Uint8Array(0) });
    merged.set(id, after);
    writes.set(id, { group, body: new Uint8Array(0), full: false });
  }
  if (writes.size === 0) return [];

  const lookup = (id: string) => {
    const object = merged.get(id);
    return object && !objectDeleted(object) ? object : undefined;
  };
  // Connectors attached to a changed object get a summary for their new route.
  for (const [id, object] of merged) {
    if (writes.has(id) || objectDeleted(object)) continue;
    if (objectRefs(object).some((ref) => writes.has(ref))) {
      writes.set(id, { group: null, body: new Uint8Array(0), full: false });
    }
  }
  const records = [...writes].map(([id, write]) => {
    const object = merged.get(id) as CanvasObject;
    const bbox: BBox = objectBounds(object, lookup) ?? [0, 0, 0, 0];
    return encodeObjectRecord({
      id,
      seq: 0,
      bbox,
      refs: objectRefs(object),
      deleted: objectDeleted(object),
      full: write.full,
      groups: write.group ? [write.group] : [],
      body: write.full ? (object.body ?? new Uint8Array(0)) : write.body,
    });
  });
  const room = canvasRoom(spaceId, documentId);
  const submitted = await submitCanvasOps(platform, room, {
    epoch: null,
    opId: `server-${crypto.randomUUID()}`,
    records,
  });
  if (!submitted) throw new Error("The canvas was replaced while it was being edited");
  // An edit the caller is told succeeded must survive a crash.
  await waitForCanvasFlush(platform, room, submitted.seq);
  return [...writes.keys()];
}
