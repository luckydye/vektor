import * as Y from "yjs";
import type { CanvasExtensionManager } from "#canvas/extensions/registry.ts";
import type { CanvasSerializedShape, CanvasShape } from "#canvas/extensions/types.ts";
import { toNumber } from "#canvas/viewport/bounds.ts";
import { normalizeRotation } from "#canvas/viewport/geometry.ts";

/**
 * Reading and writing canvas shapes as Yjs structures.
 *
 * Deliberately **not** in `canvasYjs.ts`: that module is reachable from
 * `documents/serialization.ts`, one of the server roots
 * `test/server-frontend-imports.spec.ts` guards, and this needs the extension
 * manager. Keeping them apart stops the extension graph following the seeder
 * onto the server.
 *
 * The extension manager instance, the page origin and the space id are all
 * parameters, so the same code runs in a component, a custom element, or a
 * test. The manager is per-canvas rather than a module singleton, which is why
 * it is threaded through rather than imported.
 */

export interface ShapeParseContext {
  extensions: CanvasExtensionManager;
  /** Page origin, for resolving relative URLs stored in shape data. */
  currentOrigin: string;
  defaultSpaceId: string;
}

function readNested(value: unknown, key: string): unknown {
  if (value instanceof Y.Map) return value.get(key);
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Builds a shape from a Yjs map or a plain serialized shape.
 *
 * Returns null for a type no extension claims — a document written by a newer
 * build, or an extension that has been removed. Skipping it keeps the rest of
 * the canvas rendering rather than failing the whole parse.
 */
export function shapeFromSource(
  id: string,
  source: Y.Map<unknown> | CanvasSerializedShape,
  context: ShapeParseContext,
): CanvasShape | null {
  const read = (key: string): unknown =>
    source instanceof Y.Map
      ? source.get(key)
      : (source as unknown as Record<string, unknown>)[key];

  const typeValue = read("type");
  if (!context.extensions.has(typeValue)) return null;
  const type = typeValue;
  const extension = context.extensions.get(type);
  const defaultSize = extension.defaults.size;
  const minSize = extension.defaults.minSize;
  const frameValue = read("frame");
  const styleValue = read("style");
  const dataValue = read("data");

  const storedData =
    dataValue instanceof Y.Map
      ? Object.fromEntries(dataValue.entries())
      : dataValue && typeof dataValue === "object"
        ? { ...(dataValue as Record<string, unknown>) }
        : {};
  const rawData = { ...extension.defaults.data, ...storedData };

  return {
    id,
    type,
    frame: {
      x: toNumber(readNested(frameValue, "x"), 0),
      y: toNumber(readNested(frameValue, "y"), 0),
      width: Math.max(
        minSize.width,
        toNumber(readNested(frameValue, "width"), defaultSize.width),
      ),
      height: Math.max(
        minSize.height,
        toNumber(readNested(frameValue, "height"), defaultSize.height),
      ),
      rotation: normalizeRotation(toNumber(readNested(frameValue, "rotation"), 0)),
    },
    style: {
      color:
        typeof readNested(styleValue, "color") === "string"
          ? String(readNested(styleValue, "color"))
          : extension.defaults.style.color,
    },
    data:
      extension.storage?.parseData?.(rawData, {
        currentOrigin: context.currentOrigin,
        defaultSpaceId: context.defaultSpaceId,
      }) ?? rawData,
    authorId: typeof read("authorId") === "string" ? String(read("authorId")) : undefined,
    locked: read("locked") === true || undefined,
    updatedAt: toNumber(read("updatedAt"), Date.now()),
  };
}

/**
 * Builds the Yjs map for a shape.
 *
 * Size is written only for types that persist it — text sizes itself from its
 * content, so storing a stale box would fight the measurement on reload.
 */
export function shapeToYMap(
  shape: CanvasSerializedShape,
  extensions: CanvasExtensionManager,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("type", shape.type);

  const frame = new Y.Map<unknown>();
  frame.set("x", shape.frame.x);
  frame.set("y", shape.frame.y);
  if (extensions.persistsSize(shape.type)) {
    frame.set("width", shape.frame.width);
    frame.set("height", shape.frame.height);
  }
  frame.set("rotation", shape.frame.rotation);
  map.set("frame", frame);

  const style = new Y.Map<unknown>();
  style.set("color", shape.style.color);
  map.set("style", style);

  const data = new Y.Map<unknown>();
  const serializedData =
    extensions.get(shape.type).storage?.serializeData?.(shape.data) ?? shape.data;
  for (const [key, value] of Object.entries(serializedData)) {
    if (value !== undefined) data.set(key, value);
  }
  map.set("data", data);

  if (shape.authorId) map.set("authorId", shape.authorId);
  if (shape.locked) map.set("locked", true);
  map.set("updatedAt", shape.updatedAt);
  return map;
}
