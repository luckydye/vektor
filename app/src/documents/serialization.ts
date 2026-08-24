import * as Y from "yjs";
import { parseCanvasContent, seedCanvasDoc } from "#canvas/document/index.ts";
import { codeToDoc, htmlToDoc } from "./schema/parse.ts";
import { docToHtml } from "./schema/render.ts";
import { type DocNode, textOf } from "./schema/specs.ts";
import { yDocToDoc } from "./schema/yDecode.ts";
import { docToYDoc } from "./schema/yEncode.ts";

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

function loadCanvasYDoc(content: string): Y.Doc {
  const ydoc = new Y.Doc();
  // The server is the single source of truth for room state: it seeds the doc
  // from persisted content and sends it to clients on join. Clients never seed
  // their own docs (that would assign different Yjs ids to the same shapes and
  // diverge). The deterministic seed keeps ids stable across room reloads.
  seedCanvasDoc(ydoc, parseCanvasContent(content));
  return ydoc;
}

function workflowCode(doc: Y.Doc): string {
  const block = yDocToDoc(doc).content?.find((node) => node.type === "codeBlock");
  return textOf(block);
}

/** Serializes a canvas room doc back to the snapshot content format. */
export function canvasSnapshotFromDoc(doc: Y.Doc): {
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
 * Parses persisted content into the document tree its type describes. Canvas
 * content has no tree — it lives in Y.Maps rather than the `default` fragment.
 */
export function docNodeFromContent(
  type: string | null | undefined,
  content: string,
): DocNode {
  if (type === "workflow") return codeToDoc(content, "javascript");
  return htmlToDoc(content);
}

/** Builds a Y.Doc from persisted canvas, workflow-source, or HTML content. */
export function docFromContent(type: string | null | undefined, content: string): Y.Doc {
  if (type === "canvas") return loadCanvasYDoc(content);
  return docToYDoc(docNodeFromContent(type, content));
}

/** Serializes a Y.Doc to canvas JSON, workflow source, or HTML. */
export function contentFromDoc(type: string | null | undefined, doc: Y.Doc): string {
  if (type === "canvas") return JSON.stringify(canvasSnapshotFromDoc(doc));
  if (type === "workflow") return workflowCode(doc);
  return toCleanHtml(doc);
}

/** Rebuilds a Y.Doc from an encoded state update. */
export function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}
