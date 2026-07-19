#!/usr/bin/env bun
/**
 * Micro-benchmark of the server-side canvas Yjs operations on a real (large)
 * canvas document, to find which op dominates CPU/memory on the collaboration
 * hot paths (room load, join-state encode, persist serialize).
 *
 * Read-only on the DB. Point it at any canvas document via env:
 *   BENCH_DB=data/spaces/<spaceId>.db BENCH_DOC=<documentId> \
 *     bun bench/canvas-ops.mjs
 *
 * Profiling (Bun):
 *   bun --cpu-prof-md --heap-prof bench/canvas-ops.mjs
 */
import { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import { bench, run } from "mitata";
import * as Y from "yjs";
import { parseCanvasContent, seedCanvasDoc } from "#utils/canvasYjs.ts";

const DB_PATH = process.env.BENCH_DB ?? "data/spaces/8624ada5-822e-479a-8202-f7a656e9d8ee.db";
const DOC_ID = process.env.BENCH_DOC ?? "doc_5bdef611-6543-4de0-b6c2-531400849e07";

function canvasSnapshotFromDoc(doc) {
  const collect = (name) =>
    [...doc.getMap(name).entries()].map(([id, map]) => ({
      id,
      ...(map instanceof Y.Map ? map.toJSON() : {}),
    }));
  return { version: 1, shapes: collect("canvas.shapes"), strokes: collect("canvas.strokes") };
}

const mb = (b) => (b / 1048576).toFixed(1);
function heap(label) {
  const s = heapStats();
  console.log(
    `[heap] ${label}: heapSize=${mb(s.heapSize)}MB objects=${s.objectCount} rss=${mb(process.memoryUsage().rss)}MB`,
  );
}
const time = (label, fn) => {
  const start = performance.now();
  const out = fn();
  console.log(`[time] ${label}: ${Math.round(performance.now() - start)}ms`);
  return out;
};

const db = new Database(DB_PATH, { readonly: true });
const row = db.query("SELECT content FROM document WHERE id = ?").get(DOC_ID);
if (!row) throw new Error(`document not found: ${DOC_ID} in ${DB_PATH}`);
const content = row.content;
console.log(`\ncontent = ${mb(content.length)}MB (${content.length} bytes)`);
heap("baseline");

const parsed = time("parseCanvasContent", () => parseCanvasContent(content));
console.log(`  parsed: shapes=${parsed.shapes?.length ?? "?"} strokes=${parsed.strokes?.length ?? "?"}`);

const ydoc = new Y.Doc();
time("seedCanvasDoc (build Yjs doc)", () => seedCanvasDoc(ydoc, parsed));
heap("after seedCanvasDoc");

let totalPoints = 0;
let maxPoints = 0;
for (const [, m] of ydoc.getMap("canvas.strokes").entries()) {
  const pts = m instanceof Y.Map ? m.get("points") : undefined;
  const n = Array.isArray(pts) ? pts.length : 0;
  totalPoints += n;
  if (n > maxPoints) maxPoints = n;
}
console.log(
  `  yjs doc: shapes=${[...ydoc.getMap("canvas.shapes").keys()].length} strokes=${[...ydoc.getMap("canvas.strokes").keys()].length} points=${totalPoints} maxPerStroke=${maxPoints}`,
);

time("encodeStateAsUpdate (once)", () => Y.encodeStateAsUpdate(ydoc));
time("canvasSnapshotFromDoc+stringify (once)", () => JSON.stringify(canvasSnapshotFromDoc(ydoc)));
heap("after ops");

bench("encodeStateAsUpdate", () => {
  Y.encodeStateAsUpdate(ydoc);
});
bench("canvasSnapshotFromDoc + stringify", () => {
  JSON.stringify(canvasSnapshotFromDoc(ydoc));
});
bench("applyUpdate into fresh doc", () => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(ydoc));
  d.destroy();
});

await run();
heap("final");
