import type { JSONContent } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/html";
import { Node } from "@tiptap/pm/model";
import { prosemirrorToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { contentExtensions } from "#editor/extensions.ts";
import { parseCanvasContent, seedCanvasDoc } from "./canvasYjs.ts";

/**
 * Pure, dependency-light document (de)serialization primitives shared by the
 * main thread and the serialization worker pool. Nothing here touches the DB,
 * WebSocket rooms, or any main-thread-only state, so the exact same code runs
 * off-thread inside a worker and in-process as a fallback.
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
 * line-based edit operations have a deterministic line structure. The
 * server-side @tiptap/html build adds an xmlns attribute to elements; strip
 * it so the output matches client-produced content.
 */
export function toCleanHtml(
  doc: Y.Doc,
  extensions: ReturnType<typeof contentExtensions>,
): string {
  const json = yDocToProsemirrorJSON(doc, "default") as {
    type: string;
    content?: JSONContent[];
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

/** Builds a Y.Doc from persisted content (canvas snapshot JSON or HTML). */
export function docFromContent(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
  content: string,
): Y.Doc {
  if (type === "canvas") return loadCanvasYDoc(content);
  const extensions = contentExtensions({ spaceId, documentId });
  const json = generateJSON(content, extensions);
  const schema = getSchema(extensions);
  const pmDoc = Node.fromJSON(schema, json);
  return prosemirrorToYDoc(pmDoc, "default");
}

/** Serializes a Y.Doc to its persisted content form (canvas JSON or HTML). */
export function contentFromDoc(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
  doc: Y.Doc,
): string {
  if (type === "canvas") return JSON.stringify(canvasSnapshotFromDoc(doc));
  return toCleanHtml(doc, contentExtensions({ spaceId, documentId }));
}

/** Rebuilds a Y.Doc from an encoded state update. */
export function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}
