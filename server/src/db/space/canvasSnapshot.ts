/**
 * A canvas as snapshot JSON (`{ version, shapes, strokes }`), for consumers
 * that read or write the document whole: content reads, search, export, the
 * agent's canvas API.
 */

import { bodyMarkdown } from "#canvas/document/bodyText.ts";
import {
  type CanvasObject,
  EXTENSION_STATE_TYPE,
  objectToItem,
  objectType,
} from "#canvas/document/format/object.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { writeBaseFromSnapshot } from "./canvasBase.ts";
import {
  canvasWorkingSet,
  readAllCanvasObjects,
  readBaseObjects,
} from "./canvasStore.ts";
import type { StoredDocumentContent } from "./documentContent.ts";

export interface CanvasSnapshot {
  version: 1;
  shapes: Record<string, unknown>[];
  strokes: Record<string, unknown>[];
}

export function objectsToSnapshot(objects: readonly CanvasObject[]): CanvasSnapshot {
  const snapshot: CanvasSnapshot = { version: 1, shapes: [], strokes: [] };
  for (const object of objects) {
    if (objectType(object) === EXTENSION_STATE_TYPE) continue;
    const { kind, item } = objectToItem(
      object,
      object.body ? bodyMarkdown(object.body) : undefined,
    );
    (kind === "stroke" ? snapshot.strokes : snapshot.shapes).push(item);
  }
  return snapshot;
}

/** Every live object of the canvas, as merged now, pending records included. */
export async function readCanvasSnapshot(
  s: SpaceStore,
  documentId: string,
): Promise<CanvasSnapshot> {
  return objectsToSnapshot(
    await readAllCanvasObjects(await canvasWorkingSet(s, documentId)),
  );
}

/** A revision's canvas: its base alone. */
export async function readBaseSnapshot(
  s: SpaceStore,
  baseKey: string,
): Promise<CanvasSnapshot> {
  return objectsToSnapshot(await readBaseObjects(s, baseKey));
}

export function parseCanvasSnapshot(content: string): {
  shapes?: unknown;
  strokes?: unknown;
} {
  if (!content.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Canvas content must be an object with shapes and strokes");
  }
  return parsed as { shapes?: unknown; strokes?: unknown };
}

/** A new canvas's content: snapshot JSON written as its first base. */
export async function storeCanvasContent(
  s: SpaceStore,
  documentId: string,
  content: string,
): Promise<StoredDocumentContent> {
  const base = await writeBaseFromSnapshot(s, documentId, parseCanvasSnapshot(content));
  return { documentId, content, contentKey: base.key };
}
