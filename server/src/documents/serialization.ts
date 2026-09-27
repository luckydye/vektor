import * as Y from "yjs";
import { parseCanvasContent, seedCanvasDoc } from "#canvas/document/index.ts";
import { codeToDoc, htmlToDoc } from "./schema/parse.ts";
import { docToHtml } from "./schema/render.ts";
import { type DocNode, textOf } from "./schema/specs.ts";
import { yDocToDoc } from "./schema/yDecode.ts";
import { docToYDoc } from "./schema/yEncode.ts";

export type CollaborationContentFormat =
  | "html"
  | "map-snapshot"
  | "source-code";

/**
 * Pure, dependency-light document (de)serialization primitives shared by the
 * main thread and the serialization worker pool. Nothing here touches the DB,
 * WebSocket rooms, or any main-thread-only state, so the exact same code runs
 * off-thread inside a worker and in-process as a fallback.
 *
 * HTML ⇄ `Y.XmlFragment` goes through `./schema`, driven by the shared spec
 * table. The editor is not involved: no ProseMirror schema, no `DOMSerializer`,
 * no DOM.
 */

function loadMapSnapshotYDoc(content: string): Y.Doc {
  const ydoc = new Y.Doc();
  // The server is the single source of truth for room state: it seeds the doc
  // from persisted content and sends it to clients on join. Clients never seed
  // their own docs (that would assign different Yjs ids to the same shapes and
  // diverge). The deterministic seed keeps ids stable across room reloads.
  seedCanvasDoc(ydoc, parseCanvasContent(content));
  return ydoc;
}

function sourceCode(doc: Y.Doc): string {
  const block = yDocToDoc(doc).content?.find((node) => node.type === "codeBlock");
  return textOf(block);
}

/** Serializes a map-backed room doc to its persisted JSON snapshot. */
export function mapSnapshotFromDoc(doc: Y.Doc): {
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
 * Serializes the live Y.Doc to HTML with one top-level block per line, so
 * line-based edit operations have a deterministic line structure.
 */
export function toCleanHtml(doc: Y.Doc): string {
  return docToHtml(yDocToDoc(doc));
}

/**
 * Parses persisted tree content into the shared document structure. Map
 * snapshots have no tree and are handled directly by `docFromContent`.
 */
export function docNodeFromContent(
  format: CollaborationContentFormat,
  content: string,
): DocNode {
  if (format === "source-code") return codeToDoc(content, "javascript");
  return htmlToDoc(content);
}

/** Builds a Y.Doc from persisted HTML, map-snapshot, or source-code content. */
export function docFromContent(
  format: CollaborationContentFormat,
  content: string,
): Y.Doc {
  if (format === "map-snapshot") return loadMapSnapshotYDoc(content);
  return docToYDoc(docNodeFromContent(format, content));
}

/** Serializes a Y.Doc to HTML, a map snapshot, or source code. */
export function contentFromDoc(
  format: CollaborationContentFormat,
  doc: Y.Doc,
): string {
  if (format === "map-snapshot") return JSON.stringify(mapSnapshotFromDoc(doc));
  if (format === "source-code") return sourceCode(doc);
  return toCleanHtml(doc);
}

/** Rebuilds a Y.Doc from an encoded state update. */
export function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}
