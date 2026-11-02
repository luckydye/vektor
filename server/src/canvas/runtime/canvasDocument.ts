/**
 * The canvas document as the controller edits it: shapes and strokes over the
 * object store, kept in step with the server by the sync (see
 * docs/canvas-format.md, Client).
 */

import type * as Y from "yjs";
import { bodyFromMarkdown, writeBodyMarkdown } from "#canvas/document/bodyText.ts";
import {
  type CanvasSync,
  type CanvasTransport,
  createCanvasSync,
} from "#canvas/document/canvasSync.ts";
import {
  dataRefs,
  EXTENSION_STATE_ID,
  EXTENSION_STATE_TYPE,
  type FlattenedItem,
  flattenShape,
  flattenStroke,
  objectToItem,
  objectType,
  STROKE_TYPE,
} from "#canvas/document/format/object.ts";
import { readProperty, sameValue } from "#canvas/document/format/properties.ts";
import {
  type BBox,
  encodeCursorRecord,
  encodePoints,
  type PropertyValue,
  preamble,
} from "#canvas/document/format/records.ts";
import { createCanvasObjectStore } from "#canvas/document/objectStore.ts";
import { shapeToItem } from "#canvas/document/serialization.ts";
import { strokeToItem } from "#canvas/document/strokes.ts";
import type { FreehandPoint } from "#canvas/render/freehand.ts";
import type {
  CanvasSerializedShape,
  CanvasStrokeSnapshot,
} from "#canvas/runtime/extensionApi.ts";
import type { CanvasExtensionManager } from "#canvas/runtime/registry.ts";

export interface CanvasDocumentOptions {
  transport: CanvasTransport;
  extensions: CanvasExtensionManager;
  /** The object's world bbox as laid out, for its summary. */
  bounds(id: string): BBox | null;
  /** Selected and edited ids, kept through eviction. */
  pinned(): ReadonlySet<string>;
  onBounds(bounds: BBox): void;
  onReload(): void;
  onError(error: Error): void;
}

export type CanvasDocument = ReturnType<typeof createCanvasDocument>;

/** Keys a full write of an item owns; anything else under them it does not name is removed. */
const ITEM_KEY =
  /^(type|z|updatedAt|authorId|locked|rotation|kind|points|(frame|style|data|refs)\..+)$/;

export function createCanvasDocument(options: CanvasDocumentOptions) {
  const store = createCanvasObjectStore({
    bounds: options.bounds,
    send: (records) => sync.send(records),
  });
  const sync: CanvasSync = createCanvasSync({
    transport: options.transport,
    store,
    pinned: options.pinned,
    bounds: options.bounds,
    onBounds: options.onBounds,
    onReload: options.onReload,
    onError: options.onError,
  });

  /** Live shapes, as the snapshot JSON holds them. */
  function shapeItems(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const id of store.objects.keys()) {
      const object = store.view(id);
      if (!object || !store.live(id)) continue;
      const type = objectType(object);
      if (type === STROKE_TYPE || type === EXTENSION_STATE_TYPE) continue;
      result.push(objectToItem(object, store.textOf(id)).item);
    }
    return result;
  }

  /**
   * Live strokes without decoding them: `points` is the packed value, whose
   * identity changes only when the stroke is rewritten.
   */
  function strokeEntries(): {
    id: string;
    points: unknown;
    updatedAt: unknown;
    item(): Record<string, unknown>;
  }[] {
    const result = [];
    for (const id of store.objects.keys()) {
      const object = store.view(id);
      if (!object || !store.live(id) || objectType(object) !== STROKE_TYPE) continue;
      result.push({
        id,
        points: readProperty(object.properties, "points"),
        updatedAt: readProperty(object.properties, "updatedAt"),
        item: () => objectToItem(object, undefined).item,
      });
    }
    return result;
  }

  /** Writes a whole item: new objects whole, existing ones by the keys that differ. */
  function put(flat: FlattenedItem): void {
    const existing = store.view(flat.id);
    if (!existing || !store.live(flat.id)) {
      store.create(
        flat.id,
        flat.entries,
        flat.text !== undefined ? bodyFromMarkdown(flat.text) : undefined,
      );
      return;
    }
    const named = new Set(flat.entries.map(([key]) => key));
    const entries: [string, PropertyValue][] = flat.entries.filter(
      ([key, value]) => !sameValue(readProperty(existing.properties, key), value),
    );
    for (const [key, entry] of existing.properties) {
      if (entry.value !== null && ITEM_KEY.test(key) && !named.has(key))
        entries.push([key, null]);
    }
    if (entries.length > 0) store.write(flat.id, entries);
    if (flat.text !== undefined && flat.text !== (store.textOf(flat.id) ?? ""))
      setText(flat.id, flat.text);
  }

  /** Replaces a body's text, as one body update. */
  function setText(id: string, text: string): void {
    const editing = store.editingBodies().has(id);
    writeBodyMarkdown(store.editBody(id), text);
    if (!editing) store.releaseBody(id);
  }

  function putShape(shape: CanvasSerializedShape): void {
    put(flattenShape(shapeToItem(shape, options.extensions)));
  }

  function putStroke(stroke: CanvasStrokeSnapshot): void {
    put(flattenStroke(strokeToItem(stroke)));
  }

  /**
   * Writes some of a shape's `frame`, `style` or `data` keys, with
   * `updatedAt`; `undefined` removes a key. A `data` write that changes what
   * the type references writes its `refs.*` too, under the same timestamp.
   */
  function patchShape(
    id: string,
    group: "frame" | "style" | "data",
    patch: Record<string, unknown>,
  ): void {
    const object = store.view(id);
    if (!object) return;
    const entries: [string, PropertyValue][] = Object.entries(patch).map(
      ([key, value]) => [
        `${group}.${key}`,
        value === undefined ? null : (JSON.parse(JSON.stringify(value)) as PropertyValue),
      ],
    );
    if (group === "data") {
      const type = objectType(object) ?? "";
      const data = objectToItem(object, undefined).item.data as Record<string, unknown>;
      for (const [role, ref] of Object.entries(dataRefs(type, { ...data, ...patch }))) {
        entries.push([`refs.${role}`, ref]);
      }
    }
    entries.push(["updatedAt", Date.now()]);
    store.write(id, entries);
  }

  function setLocked(id: string, locked: boolean): void {
    store.write(id, [
      ["locked", locked ? true : null],
      ["updatedAt", Date.now()],
    ]);
  }

  function setStrokePoints(id: string, points: FreehandPoint[], rotation?: number): void {
    store.write(id, [
      ["points", encodePoints(points)],
      ...(rotation !== undefined
        ? ([["rotation", rotation]] as [string, PropertyValue][])
        : []),
      ["updatedAt", Date.now()],
    ]);
  }

  function setStrokeStyle(id: string, style: Record<string, unknown>): void {
    store.write(id, [
      ...Object.entries(style).map(
        ([key, value]) =>
          [`style.${key}`, value as PropertyValue] as [string, PropertyValue],
      ),
      ["updatedAt", Date.now()],
    ]);
  }

  /**
   * The extensions' shared Y.Doc: the body of the canvas's one state object,
   * synced and stored like any body. Created on first use; one a peer created
   * meanwhile merges in when it loads.
   */
  function extensionState(): Y.Doc {
    if (!store.live(EXTENSION_STATE_ID)) {
      store.transact(
        () => store.create(EXTENSION_STATE_ID, [["type", EXTENSION_STATE_TYPE]]),
        "internal",
      );
    }
    return store.editBody(EXTENSION_STATE_ID);
  }

  return {
    store,
    sync,
    extensionState,
    shapeItems,
    strokeEntries,
    has: (id: string) => store.live(id),
    putShape,
    putStroke,
    patchShape,
    setLocked,
    setStrokePoints,
    setStrokeStyle,
    remove: (id: string) => store.remove(id),
    transact: (fn: () => void) => store.transact(fn),
    destroy: () => sync.destroy(),
  };
}

/**
 * A transport for a canvas no document backs: it joins at once, loads
 * nothing and sends nowhere.
 */
export function localCanvasTransport(): CanvasTransport {
  return {
    join(handlers) {
      queueMicrotask(() =>
        handlers.joined({ epoch: "local", seq: 0, bounds: [0, 0, 0, 0] }),
      );
      return { send() {}, leave() {} };
    },
    async load() {
      const bytes = [preamble(), encodeCursorRecord("local")];
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of bytes) controller.enqueue(chunk);
          controller.close();
        },
      });
    },
  };
}
