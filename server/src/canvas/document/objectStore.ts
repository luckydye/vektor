/**
 * The client's object store (see docs/canvas-format.md, Client): the objects
 * it holds, merged per key; local transactions turned into records; a gesture
 * overlay that commits once; an undo stack over property writes; and the
 * body docs being edited.
 */

import * as Y from "yjs";
import { bodyMarkdown, fragmentMarkdown } from "#canvas/document/bodyText.ts";
import {
  applyRecord,
  BODY_FIELD,
  bodyDoc,
  type CanvasObject,
  createObject,
  objectDeleted,
  objectRefs,
  STROKE_TYPE,
} from "#canvas/document/format/object.ts";
import {
  type Clock,
  compareTimestamps,
  createClock,
  readProperty,
  sameValue,
  stateToGroups,
  type Timestamp,
} from "#canvas/document/format/properties.ts";
import type {
  BBox,
  ObjectRecord,
  PropertyGroup,
  PropertyValue,
} from "#canvas/document/format/records.ts";

/** Who caused a change: this client, its undo stack, or someone else's record. */
export type ChangeOrigin = "local" | "undo" | "remote";

export interface CanvasStoreOptions {
  /** The object's world bbox as laid out, or null when it has none. */
  bounds(id: string): BBox | null;
  /** Records of one local transaction, to be sent in one frame. */
  send(records: ObjectRecord[]): void;
}

interface UndoKey {
  previous: PropertyValue | undefined;
  stamp: Timestamp;
}

/** One user action: for each object, what each key it wrote held before. */
type UndoEntry = Map<string, Map<string, UndoKey>>;

interface PendingObject {
  entries: Map<string, PropertyValue>;
  body: Uint8Array[];
  full: boolean;
}

export type CanvasObjectStore = ReturnType<typeof createCanvasObjectStore>;

export function createCanvasObjectStore(options: CanvasStoreOptions) {
  const objects = new Map<string, CanvasObject>();
  const texts = new Map<string, string>();
  const liveBodies = new Map<string, Y.Doc>();
  const listeners = new Set<(ids: ReadonlySet<string>, origin: ChangeOrigin) => void>();
  const clock: Clock = createClock();
  const undoStack: UndoEntry[] = [];
  const redoStack: UndoEntry[] = [];

  /** Gesture overlay: values shown but not written until the gesture commits. */
  let overlay: Map<string, Map<string, PropertyValue>> | null = null;
  let pending: Map<string, PendingObject> | null = null;
  let pendingOrigin: ChangeOrigin = "local";
  let depth = 0;

  function notify(ids: ReadonlySet<string>, origin: ChangeOrigin) {
    if (ids.size === 0) return;
    for (const listener of [...listeners]) listener(ids, origin);
  }

  /** The object as it renders: its merged state with the gesture overlay on top. */
  function view(id: string): CanvasObject | undefined {
    const object = objects.get(id);
    const shown = overlay?.get(id);
    if (!object || !shown) return object;
    const properties = new Map(object.properties);
    for (const [key, value] of shown) {
      properties.set(key, {
        value,
        counter: Number.MAX_SAFE_INTEGER,
        writer: "f".repeat(16),
      });
    }
    return { id, properties, body: object.body };
  }

  function live(id: string): boolean {
    const object = view(id);
    return Boolean(object && !objectDeleted(object));
  }

  function textOf(id: string): string | undefined {
    const doc = liveBodies.get(id);
    if (doc) return fragmentMarkdown(doc.getXmlFragment(BODY_FIELD));
    const object = objects.get(id);
    if (!object?.body) return undefined;
    let text = texts.get(id);
    if (text === undefined) {
      text = bodyMarkdown(object.body);
      texts.set(id, text);
    }
    return text;
  }

  /** Runs `fn` as one transaction: its writes become one record per object. */
  function transact(fn: () => void, origin: ChangeOrigin = "local"): void {
    if (depth === 0) {
      pending = new Map();
      pendingOrigin = origin;
    }
    depth++;
    try {
      fn();
    } finally {
      depth--;
      if (depth === 0) {
        const written = pending as Map<string, PendingObject>;
        pending = null;
        commit(written, pendingOrigin);
      }
    }
  }

  function pendingFor(id: string): PendingObject {
    if (!pending) throw new Error("Canvas writes must run inside a transaction");
    let entry = pending.get(id);
    if (!entry) {
      entry = { entries: new Map(), body: [], full: false };
      pending.set(id, entry);
    }
    return entry;
  }

  /** Writes `entries` to `id`; `null` removes a key. Inside a gesture, only the overlay changes. */
  function write(id: string, entries: Iterable<[string, PropertyValue]>): void {
    if (overlay && depth === 0) {
      let shown = overlay.get(id);
      if (!shown) {
        shown = new Map();
        overlay.set(id, shown);
      }
      for (const [key, value] of entries) shown.set(key, value);
      notify(new Set([id]), "local");
      return;
    }
    if (depth === 0) {
      transact(() => write(id, entries));
      return;
    }
    const target = pendingFor(id);
    for (const [key, value] of entries) target.entries.set(key, value);
  }

  /** A new object with its whole state. */
  function create(
    id: string,
    entries: Iterable<[string, PropertyValue]>,
    body?: Uint8Array,
  ) {
    const run = () => {
      const target = pendingFor(id);
      target.full = true;
      target.entries.set("deleted", false);
      for (const [key, value] of entries) target.entries.set(key, value);
      if (body && body.length > 0) target.body.push(body);
    };
    if (depth === 0) transact(run);
    else run();
  }

  function remove(id: string): void {
    write(id, [["deleted", true]]);
  }

  function writeBody(id: string, update: Uint8Array): void {
    const run = () => pendingFor(id).body.push(update);
    if (depth === 0) transact(run);
    else run();
  }

  function commit(written: Map<string, PendingObject>, origin: ChangeOrigin): void {
    const undo: UndoEntry = new Map();
    const records = new Map<
      string,
      { group: PropertyGroup | null; body: Uint8Array; full: boolean }
    >();
    for (const [id, change] of written) {
      const object = objects.get(id) ?? createObject(id);
      objects.set(id, object);
      let group: PropertyGroup | null = null;
      const entries = [...change.entries].filter(
        ([key, value]) =>
          change.full || !sameValue(readProperty(object.properties, key), value),
      );
      if (entries.length > 0) {
        const stamp = clock.next(object.properties);
        group = { ...stamp, entries };
        // Undoing a create deletes the object; any other write restores what each key held.
        const keys = new Map<string, UndoKey>(
          change.full
            ? [["deleted", { previous: true, stamp }]]
            : entries.map(([key]) => [
                key,
                { previous: readProperty(object.properties, key), stamp },
              ]),
        );
        undo.set(id, keys);
      }
      const body =
        change.body.length > 0 ? Y.mergeUpdates(change.body) : new Uint8Array(0);
      if (!group && body.length === 0) continue;
      applyRecord(object, { groups: group ? [group] : [], body });
      texts.delete(id);
      // An undone delete sends the whole object: a base rewrite may have dropped it.
      const revived = group?.entries.some(
        ([key, value]) => key === "deleted" && value === false,
      );
      records.set(id, { group, body, full: change.full || Boolean(revived) });
    }
    if (records.size === 0) return;
    if (undo.size > 0) {
      if (origin === "local") {
        undoStack.push(undo);
        redoStack.length = 0;
      } else if (origin === "undo") {
        pendingUndoTarget?.push(undo);
      }
    }
    const changed = new Set(records.keys());
    notify(changed, origin === "remote" ? "remote" : "local");
    options.send(buildRecords(records));
  }

  /** The records of a transaction, plus summaries for the connectors its objects move. */
  function buildRecords(
    written: Map<
      string,
      { group: PropertyGroup | null; body: Uint8Array; full: boolean }
    >,
  ): ObjectRecord[] {
    const result: ObjectRecord[] = [];
    for (const [id, write] of written) {
      const object = objects.get(id) as CanvasObject;
      result.push({
        ...summaryRecord(id),
        full: write.full,
        // A full record carries every winning value and the whole body.
        groups: write.full
          ? stateToGroups(object.properties)
          : write.group
            ? [write.group]
            : [],
        body: write.full ? (object.body ?? new Uint8Array(0)) : write.body,
      });
    }
    for (const id of referencing(new Set(written.keys()))) {
      if (written.has(id)) continue;
      result.push(summaryRecord(id));
    }
    return result;
  }

  /** A record with only the object's summary, computed from its state. */
  function summaryRecord(id: string): ObjectRecord {
    const object = objects.get(id) as CanvasObject;
    return {
      id,
      seq: 0,
      bbox: options.bounds(id) ?? [0, 0, 0, 0],
      refs: objectRefs(object),
      deleted: objectDeleted(object),
      full: false,
      groups: [],
      body: new Uint8Array(0),
    };
  }

  /** Held objects referencing any of `ids`, transitively. */
  function referencing(ids: ReadonlySet<string>): Set<string> {
    const found = new Set<string>();
    let frontier = new Set(ids);
    while (frontier.size > 0) {
      const next = new Set<string>();
      for (const object of objects.values()) {
        if (found.has(object.id) || ids.has(object.id) || objectDeleted(object)) continue;
        if (objectRefs(object).some((ref) => frontier.has(ref))) {
          found.add(object.id);
          next.add(object.id);
        }
      }
      frontier = next;
    }
    return found;
  }

  /** Merges someone else's record, or a load response's, into the store. */
  function applyRemote(records: readonly ObjectRecord[]): void {
    const changed = new Set<string>();
    for (const record of records) {
      let object = objects.get(record.id);
      if (!object) {
        object = createObject(record.id);
        objects.set(record.id, object);
      }
      const result = applyRecord(object, record);
      if (result.body) {
        texts.delete(record.id);
        const doc = liveBodies.get(record.id);
        if (doc) Y.applyUpdate(doc, record.body, store);
      }
      if (result.keys.length > 0 || result.body || record.groups.length === 0) {
        changed.add(record.id);
      }
    }
    notify(changed, "remote");
  }

  function beginGesture(): void {
    overlay ??= new Map();
  }

  /** Ends the gesture: its overlay becomes one transaction, or is dropped. */
  function endGesture(commitIt: boolean): void {
    const shown = overlay;
    overlay = null;
    if (!shown || shown.size === 0) return;
    if (!commitIt) {
      notify(new Set(shown.keys()), "local");
      return;
    }
    transact(() => {
      for (const [id, entries] of shown) write(id, entries);
    });
  }

  let pendingUndoTarget: UndoEntry[] | null = null;

  /** Writes back what `entry` replaced, for keys whose winning write is still its own. */
  function revert(entry: UndoEntry, into: UndoEntry[]): void {
    pendingUndoTarget = into;
    try {
      transact(() => {
        for (const [id, keys] of entry) {
          const object = objects.get(id);
          if (!object) continue;
          const entries: [string, PropertyValue][] = [];
          for (const [key, undoKey] of keys) {
            const current = object.properties.get(key);
            if (!current || compareTimestamps(current, undoKey.stamp) !== 0) continue;
            // A delete undone is `deleted: false`, which sends the whole object.
            entries.push([key, undoKey.previous ?? (key === "deleted" ? false : null)]);
          }
          if (entries.length > 0) write(id, entries);
        }
      }, "undo");
    } finally {
      pendingUndoTarget = null;
    }
  }

  function undo(): void {
    const entry = undoStack.pop();
    if (entry) revert(entry, redoStack);
  }

  function redo(): void {
    const entry = redoStack.pop();
    if (entry) revert(entry, undoStack);
  }

  /** Ids an undo or redo may still touch; they are kept through eviction. */
  function undoIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of [...undoStack, ...redoStack])
      for (const id of entry.keys()) ids.add(id);
    return ids;
  }

  /**
   * The body doc for editing, with a fresh Yjs client id: a doc rebuilt from
   * state lacking some of its own updates would otherwise reuse clocks.
   */
  function editBody(id: string): Y.Doc {
    let doc = liveBodies.get(id);
    if (doc) return doc;
    doc = bodyDoc(objects.get(id)?.body ?? null);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === store) return;
      writeBody(id, update);
    });
    liveBodies.set(id, doc);
    return doc;
  }

  function releaseBody(id: string): void {
    const doc = liveBodies.get(id);
    if (!doc) return;
    liveBodies.delete(id);
    doc.destroy();
    texts.delete(id);
  }

  /** Forgets objects the region loader evicted. */
  function evict(ids: Iterable<string>): void {
    const removed = new Set<string>();
    for (const id of ids) {
      if (liveBodies.has(id)) continue;
      objects.delete(id);
      texts.delete(id);
      removed.add(id);
    }
    notify(removed, "remote");
  }

  /** Drops everything, for a restore that replaced the document. */
  function clear(): void {
    const ids = new Set(objects.keys());
    objects.clear();
    texts.clear();
    for (const doc of liveBodies.values()) doc.destroy();
    liveBodies.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    overlay = null;
    notify(ids, "remote");
  }

  const store = {
    objects,
    view,
    live,
    textOf,
    transact,
    write,
    create,
    remove,
    writeBody,
    applyRemote,
    beginGesture,
    endGesture,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoIds,
    editBody,
    releaseBody,
    editingBodies: () => new Set(liveBodies.keys()),
    evict,
    clear,
    summaryRecord,
    isStroke: (id: string) =>
      readProperty(objects.get(id)?.properties ?? new Map(), "type") === STROKE_TYPE,
    listen(listener: (ids: ReadonlySet<string>, origin: ChangeOrigin) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}
