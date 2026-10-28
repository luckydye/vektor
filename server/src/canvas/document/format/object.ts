/**
 * Objects: an id, properties merged per key, and optionally a body, a Yjs
 * update holding rich text. A shape or a stroke of today's snapshot JSON maps
 * onto one object, its nested maps flattened to dotted keys.
 */

import * as Y from "yjs";
import {
  applyGroups,
  type PropertyState,
  readProperty,
  stateToGroups,
} from "#canvas/document/format/properties.ts";
import {
  type BBox,
  decodePoints,
  encodePoints,
  type JsonValue,
  type ObjectRecord,
  type PropertyValue,
  type StrokePoint,
} from "#canvas/document/format/records.ts";

export interface CanvasObject {
  id: string;
  properties: PropertyState;
  /** The body's encoded state, null for none. */
  body: Uint8Array | null;
}

/** The type of objects that are strokes rather than shapes. */
export const STROKE_TYPE = "stroke";

/**
 * The one object per canvas whose body is the extensions' shared Y.Doc
 * (`ctx.collaboration`). It has no geometry, is never drawn and is not part of
 * the snapshot JSON.
 */
export const EXTENSION_STATE_ID = "extension-state";
export const EXTENSION_STATE_TYPE = "extension-state";

/** The `XmlFragment` of a body doc the rich-text editor binds to. */
export const BODY_FIELD = "text";

export function createObject(id: string): CanvasObject {
  return { id, properties: new Map(), body: null };
}

/** Merges `record` into `object`: the winning value per key, the body updates combined. */
export function applyRecord(
  object: CanvasObject,
  record: Pick<ObjectRecord, "groups" | "body">,
): { keys: string[]; body: boolean } {
  const keys = applyGroups(object.properties, record.groups);
  const body = record.body.length > 0;
  if (body) {
    object.body = object.body ? Y.mergeUpdates([object.body, record.body]) : record.body;
  }
  return { keys, body };
}

export function objectDeleted(object: CanvasObject): boolean {
  return readProperty(object.properties, "deleted") === true;
}

export function objectType(object: CanvasObject): string | undefined {
  const type = readProperty(object.properties, "type");
  return typeof type === "string" ? type : undefined;
}

/** The ids named by `refs.<role>` properties, in role order. */
export function objectRefs(object: CanvasObject): string[] {
  const refs: string[] = [];
  for (const key of [...object.properties.keys()].sort()) {
    if (!key.startsWith("refs.")) continue;
    const value = readProperty(object.properties, key);
    if (typeof value === "string" && !refs.includes(value)) refs.push(value);
  }
  return refs;
}

/** The object's whole state as one `full` record. */
export function objectToRecord(
  object: CanvasObject,
  bbox: BBox,
  seq: number,
): ObjectRecord {
  return {
    id: object.id,
    seq,
    bbox,
    refs: objectRefs(object),
    deleted: objectDeleted(object),
    full: true,
    groups: stateToGroups(object.properties),
    body: object.body ?? new Uint8Array(0),
  };
}

/** A new body doc holding `state`, for editing or decoding. */
export function bodyDoc(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

/** Re-encodes a body, which garbage-collects deleted content. */
export function compactBody(state: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(bodyDoc(state));
}

/**
 * `refs.<role>` for a type whose `data` names other objects. `line` is built
 * in: its ends name the shapes they are bound to.
 */
export function dataRefs(
  type: string,
  data: Record<string, unknown>,
): Record<string, string | null> {
  if (type !== "line") return {};
  const end = (value: unknown) => {
    const shape = (value as { shape?: unknown } | null)?.shape;
    return typeof shape === "string" ? shape : null;
  };
  return { start: end(data.start), end: end(data.end) };
}

function plainValue(value: unknown): PropertyValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue[] | { [key: string]: JsonValue };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A snapshot item as properties, and the rich text that becomes its body. */
export interface FlattenedItem {
  id: string;
  entries: [string, PropertyValue][];
  text: string | undefined;
}

/** A shape of the snapshot JSON as properties; `data.text` is split off for the body. */
export function flattenShape(shape: Record<string, unknown>): FlattenedItem {
  if (typeof shape.id !== "string") throw new Error("Canvas shape without an id");
  const type = typeof shape.type === "string" ? shape.type : "note";
  const entries: [string, PropertyValue][] = [["type", type]];
  const data = record(shape.data);
  for (const [key, value] of Object.entries(record(shape.frame))) {
    const plain = plainValue(value);
    if (plain !== undefined) entries.push([`frame.${key}`, plain]);
  }
  for (const [key, value] of Object.entries(record(shape.style))) {
    const plain = plainValue(value);
    if (plain !== undefined) entries.push([`style.${key}`, plain]);
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === "text") continue;
    const plain = plainValue(value);
    if (plain !== undefined) entries.push([`data.${key}`, plain]);
  }
  for (const [role, ref] of Object.entries(dataRefs(type, data))) {
    entries.push([`refs.${role}`, ref]);
  }
  for (const key of ["z", "updatedAt", "authorId"] as const) {
    const plain = plainValue(shape[key]);
    if (plain !== undefined) entries.push([key, plain]);
  }
  if (shape.locked === true) entries.push(["locked", true]);
  return {
    id: shape.id,
    entries,
    text: typeof data.text === "string" ? data.text : undefined,
  };
}

/** A stroke of the snapshot JSON as properties, its points packed. */
export function flattenStroke(stroke: Record<string, unknown>): FlattenedItem {
  if (typeof stroke.id !== "string") throw new Error("Canvas stroke without an id");
  const points = Array.isArray(stroke.points)
    ? (stroke.points as Partial<StrokePoint>[]).filter(
        (point) => typeof point?.x === "number" && typeof point?.y === "number",
      )
    : [];
  const style = record(stroke.style);
  const fallbackWidth = typeof style.width === "number" ? style.width : 4;
  const entries: [string, PropertyValue][] = [
    ["type", STROKE_TYPE],
    [
      "points",
      encodePoints(
        points.map((point) => ({
          x: point.x as number,
          y: point.y as number,
          // @deprecated Stamped shapes used to store points without a width.
          width: point.width ?? fallbackWidth,
        })),
      ),
    ],
  ];
  for (const [key, value] of Object.entries(style)) {
    const plain = plainValue(value);
    if (plain !== undefined) entries.push([`style.${key}`, plain]);
  }
  if (stroke.kind === "shape") entries.push(["kind", "shape"]);
  for (const key of ["rotation", "z", "updatedAt", "authorId"] as const) {
    const plain = plainValue(stroke[key]);
    if (plain !== undefined) entries.push([key, plain]);
  }
  if (stroke.locked === true) entries.push(["locked", true]);
  return { id: stroke.id, entries, text: undefined };
}

function unflatten(properties: PropertyState, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of properties.keys()) {
    if (!key.startsWith(prefix)) continue;
    const value = readProperty(properties, key);
    if (value !== undefined) result[key.slice(prefix.length)] = value;
  }
  return result;
}

/**
 * The object as a shape or stroke of the snapshot JSON, `text` being its
 * body's decoded text. The inverse of `flattenShape` and `flattenStroke`.
 */
export function objectToItem(
  object: CanvasObject,
  text: string | undefined,
): { kind: "shape" | "stroke"; item: Record<string, unknown> } {
  const properties = object.properties;
  const read = (key: string) => readProperty(properties, key);
  const item: Record<string, unknown> = { id: object.id };
  const type = objectType(object);
  if (type === STROKE_TYPE) {
    const points = read("points");
    item.points = points instanceof Uint8Array ? decodePoints(points) : [];
    item.style = unflatten(properties, "style.");
    if (read("kind") === "shape") item.kind = "shape";
    for (const key of ["rotation", "z", "updatedAt", "authorId"]) {
      if (read(key) !== undefined) item[key] = read(key);
    }
    if (read("locked") === true) item.locked = true;
    return { kind: "stroke", item };
  }
  item.type = type ?? "note";
  item.frame = unflatten(properties, "frame.");
  item.style = unflatten(properties, "style.");
  const data = unflatten(properties, "data.");
  if (text !== undefined) data.text = text;
  item.data = data;
  for (const key of ["z", "updatedAt", "authorId"]) {
    if (read(key) !== undefined) item[key] = read(key);
  }
  if (read("locked") === true) item.locked = true;
  return { kind: "shape", item };
}
