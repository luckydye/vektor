import type { CanvasSerializedShape, CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { normalizeRotation, toNumber } from "#canvas/runtime/geometry.ts";
import type { CanvasExtensionManager } from "#canvas/runtime/registry.ts";

/**
 * Canvas shapes as the snapshot items objects flatten to and from (see
 * `#canvas/document/format/object.ts`).
 *
 * Needs the extension manager, so it stays out of the server-safe document
 * entry. The manager is per-canvas rather than a module singleton, hence
 * threaded through as a parameter.
 */

function readNested(value: unknown, key: string): unknown {
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Builds a shape from a serialized shape.
 *
 * Returns null for a type no extension claims — a document written by a newer
 * build, or an extension that has been removed. Skipping it keeps the rest of
 * the canvas rendering rather than failing the whole parse.
 */
export function shapeFromSource(
  id: string,
  source: CanvasSerializedShape | Record<string, unknown>,
  context: {
    extensions: CanvasExtensionManager;
    /** Page origin, for resolving relative URLs stored in shape data. */
    currentOrigin: string;
    defaultSpaceId: string;
  },
): CanvasShape | null {
  const read = (key: string): unknown => (source as Record<string, unknown>)[key];

  const typeValue = read("type");
  if (!context.extensions.has(typeValue)) return null;
  const type = typeValue;
  const extension = context.extensions.get(type);
  const defaultSize = extension.defaults.size;
  const minSize = extension.defaults.minSize;
  const frameValue = read("frame");
  const updatedAt = toNumber(read("updatedAt"), Date.now());
  const styleValue = read("style");
  const dataValue = read("data");

  const storedData =
    dataValue && typeof dataValue === "object"
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
    updatedAt,
    // @deprecated Shapes stored before `z` existed stack by their last edit.
    z: toNumber(read("z"), updatedAt),
  };
}

/**
 * The snapshot item for a shape.
 *
 * Size is written only for types that persist it — text sizes itself from its
 * content, so storing a stale box would fight the measurement on reload.
 */
export function shapeToItem(
  shape: CanvasSerializedShape,
  extensions: CanvasExtensionManager,
): Record<string, unknown> {
  const data =
    extensions.get(shape.type).storage?.serializeData?.(shape.data) ?? shape.data;
  return {
    id: shape.id,
    type: shape.type,
    frame: {
      x: shape.frame.x,
      y: shape.frame.y,
      ...(extensions.persistsSize(shape.type)
        ? { width: shape.frame.width, height: shape.frame.height }
        : {}),
      rotation: shape.frame.rotation,
    },
    style: { color: shape.style.color },
    data: Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    ),
    ...(shape.authorId ? { authorId: shape.authorId } : {}),
    ...(shape.locked ? { locked: true } : {}),
    updatedAt: shape.updatedAt,
    z: shape.z ?? shape.updatedAt,
  };
}
