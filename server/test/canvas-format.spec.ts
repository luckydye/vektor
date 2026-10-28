/**
 * The canvas object store end to end (docs/canvas-format.md, Testing): real
 * clients — the app's object store and sync engine — over the realtime socket
 * and the load endpoint of a spawned server.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { objectBounds } from "#canvas/agent/objectBounds.ts";
import {
  CanvasCatchUpRefused,
  type CanvasSync,
  type CanvasTransport,
} from "#canvas/document/canvasSync.ts";
import { BODY_FIELD } from "#canvas/document/format/object.ts";
import { readProperty } from "#canvas/document/format/properties.ts";
import {
  type BBox,
  decodeObjectPayload,
  encodeObjectRecord,
  type ObjectRecord,
  RecordKind,
} from "#canvas/document/format/records.ts";
import { streamRecords } from "#canvas/document/format/stream.ts";
import type { CanvasObjectStore } from "#canvas/document/objectStore.ts";
import { type CanvasDocument, createCanvasDocument } from "#canvas/runtime/canvasDocument.ts";
import type { CanvasExtensionManager } from "#canvas/runtime/registry.ts";
import {
  decodeCanvasOps,
  encodeCanvasOps,
  WsMsgType,
  wsDecode,
  wsDecodeDocumentFrame,
  wsEncodeDocumentFrame,
} from "#realtime/protocol.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

async function until(condition: () => boolean, what: string, timeoutMs = 8000) {
  await eventually(async () => condition(), what, timeoutMs);
}

/** Polls `check` until it holds; bounded, so a regression fails instead of hanging. */
async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 8000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function note(id: string, x: number, y: number, text?: string) {
  return {
    id,
    type: "note",
    frame: { x, y, width: 180, height: 120, rotation: 0 },
    style: { color: "#fef3c7" },
    data: text === undefined ? {} : { text },
    updatedAt: 1,
    z: 1,
  };
}

function line(id: string, from: string, to: string) {
  return {
    id,
    type: "line",
    frame: { x: 0, y: 0, rotation: 0 },
    style: { color: "#111827" },
    data: { start: { shape: from, x: 0, y: 0 }, end: { shape: to, x: 0, y: 0 } },
    updatedAt: 1,
    z: 2,
  };
}

interface Server {
  baseUrl: string;
  api: ReturnType<typeof createApiRequest>;
  spaceId: string;
}

async function createCanvas(server: Server, shapes: unknown[], strokes: unknown[] = []) {
  const response = await server.api(`/api/v1/spaces/${server.spaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      type: "canvas",
      content: JSON.stringify({ version: 1, shapes, strokes }),
      properties: { title: "Canvas" },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).document.id as string;
}

async function readCanvas(server: Server, documentId: string) {
  const response = await server.api(`/api/v1/spaces/${server.spaceId}/documents/${documentId}`);
  expect(response.status).toBe(200);
  return JSON.parse((await response.json()).document.content) as {
    shapes: { id: string; frame: Record<string, number>; style: { color: string }; data: Record<string, unknown> }[];
    strokes: { id: string }[];
  };
}

/** Ids a load with `query` returns, decoded from the binary response. */
async function loadIds(server: Server, documentId: string, query: object): Promise<string[]> {
  const response = await server.api(
    `/api/v1/spaces/${server.spaceId}/documents/${documentId}/canvas`,
    { method: "POST", body: JSON.stringify(query) },
  );
  expect(response.status).toBe(200);
  const ids = new Set<string>();
  for await (const record of streamRecords(response.body as ReadableStream<Uint8Array>, {
    preamble: true,
  })) {
    if (record.kind !== RecordKind.object) continue;
    const decoded = decodeObjectPayload(record.payload);
    if (!decoded.deleted) ids.add(decoded.id);
  }
  return [...ids].sort();
}

/** Saves a revision of the current state, which rewrites the base. */
async function saveRevision(server: Server, documentId: string) {
  const content = JSON.stringify(await readCanvas(server, documentId));
  const response = await server.api(`/api/v1/spaces/${server.spaceId}/documents/${documentId}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  expect(response.status).toBe(200);
}

interface Client {
  document: CanvasDocument;
  store: CanvasObjectStore;
  sync: CanvasSync;
  joined: () => boolean;
  reloads: () => number;
  errors: Error[];
  /** Closes the socket as a network failure would; it reconnects on its own. */
  drop(): void;
  /** Closes the socket and keeps it closed until `resume`. */
  pause(): void;
  resume(): void;
  close(): void;
}

/** A client: the app's store and sync over a socket of its own, reconnecting until closed. */
function openClient(server: Server, documentId: string, viewport: BBox): Client {
  let socket: WebSocket | null = null;
  let closed = false;
  let paused = false;
  let joins = 0;
  let reloads = 0;
  const errors: Error[] = [];
  let handlers: Parameters<CanvasTransport["join"]>[0] | null = null;

  function connect() {
    const ws = new WebSocket(`${server.baseUrl.replace("http", "ws")}/events/${server.spaceId}`);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      ws.send(wsEncodeDocumentFrame(WsMsgType.CanvasJoin, documentId, new Uint8Array(0)));
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws || !handlers) return;
      const frame = wsDecode(new Uint8Array(event.data as ArrayBuffer));
      if (frame.type < WsMsgType.CanvasJoined || frame.type > WsMsgType.CanvasReload) return;
      const { payload } = wsDecodeDocumentFrame(frame.payload);
      if (frame.type === WsMsgType.CanvasOps) {
        const ops = decodeCanvasOps(payload, false);
        handlers.ops(ops.opId, ops.records);
        return;
      }
      const json = JSON.parse(new TextDecoder().decode(payload));
      if (frame.type === WsMsgType.CanvasJoined) {
        joins++;
        handlers.joined(json);
      } else if (frame.type === WsMsgType.CanvasFlushed) handlers.flushed(json);
      else handlers.reload(json);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws || closed || paused) return;
      setTimeout(() => {
        if (!closed && !paused) connect();
      }, 100);
    });
  }

  const transport: CanvasTransport = {
    join(next) {
      handlers = next;
      connect();
      return {
        send(epoch, opId, records) {
          if (socket?.readyState !== WebSocket.OPEN) return;
          socket.send(
            wsEncodeDocumentFrame(
              WsMsgType.CanvasOps,
              documentId,
              encodeCanvasOps({ epoch, opId, records }),
            ),
          );
        },
        leave() {
          closed = true;
          socket?.close();
        },
      };
    },
    async load(query) {
      const response = await server.api(
        `/api/v1/spaces/${server.spaceId}/documents/${documentId}/canvas`,
        { method: "POST", body: JSON.stringify(query) },
      );
      if (response.status === 409) throw new CanvasCatchUpRefused(await response.text());
      if (!response.ok || !response.body) throw new Error(`Load failed: ${response.status}`);
      return response.body;
    },
  };

  const bounds = (id: string) => {
    const object = document.store.view(id);
    return object ? objectBounds(object, (ref) => document.store.view(ref)) : null;
  };
  // The app's document over the store and sync; these specs never write shapes
  // through extension serialization, so no extension manager is needed.
  const document: CanvasDocument = createCanvasDocument({
    transport,
    extensions: {} as CanvasExtensionManager,
    bounds,
    pinned: () => new Set(),
    onBounds() {},
    onReload() {
      reloads++;
    },
    onError(error) {
      errors.push(error);
    },
  });
  const { store, sync } = document;
  sync.setViewport(viewport);

  return {
    document,
    store,
    sync,
    joined: () => joins > 0,
    reloads: () => reloads,
    errors,
    drop() {
      socket?.close();
    },
    pause() {
      paused = true;
      socket?.close();
    },
    resume() {
      paused = false;
      connect();
    },
    close() {
      sync.destroy();
    },
  };
}

/** Sends one record on a socket of its own, once joined. */
async function sendRaw(server: Server, documentId: string, record: ObjectRecord) {
  const ws = new WebSocket(`${server.baseUrl.replace("http", "ws")}/events/${server.spaceId}`);
  ws.binaryType = "arraybuffer";
  const epoch = await new Promise<string>((resolve, reject) => {
    ws.addEventListener("open", () =>
      ws.send(wsEncodeDocumentFrame(WsMsgType.CanvasJoin, documentId, new Uint8Array(0))),
    );
    ws.addEventListener("error", () => reject(new Error("websocket error")));
    ws.addEventListener("message", (event) => {
      const frame = wsDecode(new Uint8Array(event.data as ArrayBuffer));
      if (frame.type !== WsMsgType.CanvasJoined) return;
      const { payload } = wsDecodeDocumentFrame(frame.payload);
      resolve(JSON.parse(new TextDecoder().decode(payload)).epoch);
    });
  });
  const echoed = new Promise<void>((resolve) => {
    ws.addEventListener("message", (event) => {
      if (wsDecode(new Uint8Array(event.data as ArrayBuffer)).type === WsMsgType.CanvasOps) {
        resolve();
      }
    });
  });
  ws.send(
    wsEncodeDocumentFrame(
      WsMsgType.CanvasOps,
      documentId,
      encodeCanvasOps({ epoch, opId: "raw", records: [encodeObjectRecord(record)] }),
    ),
  );
  await echoed;
  ws.close();
}

function property(client: Client, id: string, key: string) {
  const object = client.store.objects.get(id);
  return object ? readProperty(object.properties, key) : undefined;
}

function bodyText(client: Client, id: string): string {
  return client.store.textOf(id) ?? "";
}

/** Types `text` at the start of the body's first paragraph, as the editor would. */
function typeInto(client: Client, id: string, text: string) {
  const doc = client.store.editBody(id);
  const paragraph = doc.getXmlFragment(BODY_FIELD).get(0) as Y.XmlElement;
  const run = paragraph.get(0) as Y.XmlText;
  run.insert(0, text);
}

const AROUND_ORIGIN: BBox = [-200, -200, 400, 400];

describe("canvas object store", () => {
  const PORT = 7493;
  let process: TestServerProcess;
  const server: Server = {
    baseUrl: testBaseUrl(PORT),
    api: createApiRequest(testBaseUrl(PORT)),
    spaceId: "",
  };
  const clients: Client[] = [];
  const client = (documentId: string, viewport = AROUND_ORIGIN) => {
    const opened = openClient(server, documentId, viewport);
    clients.push(opened);
    return opened;
  };

  beforeAll(async () => {
    process = startTestServer(PORT, {
      VEKTOR_NO_AUTH: "1",
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_API_ONLY: "1",
    });
    await waitForServer(server.baseUrl);
    const response = await server.api("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Canvas Format", slug: "canvas-format" }),
    });
    server.spaceId = (await response.json()).space.id;
  });

  afterAll(() => {
    for (const opened of clients) opened.close();
    process?.kill();
  });

  describe("loading", () => {
    it("loads the viewport's objects, the connectors attached to them and their endpoints", async () => {
      const id = await createCanvas(server, [
        note("a", 0, 0),
        note("b", 5000, 0),
        line("c", "a", "b"),
        note("d", 10000, 10000),
      ]);
      expect(await loadIds(server, id, { view: [-10, -10, 10, 10] })).toEqual(["a", "b", "c"]);

      const p = client(id);
      await until(() => ["a", "b", "c"].every((key) => p.store.objects.has(key)), "the region");
      expect(p.store.objects.has("d")).toBe(false);
    });

    it("brings in a shape another client moves into the region, with its full state", async () => {
      const id = await createCanvas(server, [note("a", 0, 0), note("far", 9000, 9000)]);
      const p = client(id);
      const q = client(id, [8800, 8800, 9400, 9400]);
      await until(() => p.store.objects.has("a") && q.store.objects.has("far"), "both regions");
      expect(p.store.objects.has("far")).toBe(false);

      q.store.write("far", [
        ["frame.x", 100],
        ["frame.y", 100],
      ]);
      await until(() => property(p, "far", "frame.x") === 100, "the moved shape");
      expect(property(p, "far", "type")).toBe("note");
      expect(property(p, "far", "frame.width")).toBe(180);
    });
  });

  describe("metadata reads", () => {
    it("leaves a canvas's content out of a metadata-only read", async () => {
      const id = await createCanvas(server, [note("a", 0, 0, "hello")]);
      const response = await server.api(
        `/api/v1/spaces/${server.spaceId}/documents/${id}?canvasContent=false`,
      );
      expect(response.status).toBe(200);
      const { document } = await response.json();
      expect(document.type).toBe("canvas");
      expect(document.properties.title).toBe("Canvas");
      expect(document.content).toBe("");
      // Any other read still gets the whole canvas.
      expect((await readCanvas(server, id)).shapes.map((shape) => shape.id)).toEqual(["a"]);
    });
  });

  describe("extension state", () => {
    it("syncs the extensions' Y.Doc between clients, keeps it out of the shapes, and stores it", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      const p = client(id);
      const q = client(id);
      await until(() => p.joined() && q.store.objects.has("a"), "the room");

      p.document.extensionState().getMap("game.test").set("score", 3);
      await until(
        () => q.document.extensionState().getMap("game.test").get("score") === 3,
        "the shared state",
      );
      // Not a shape: no snapshot reader sees it, and creating it was no user action.
      expect((await readCanvas(server, id)).shapes.map((shape) => shape.id)).toEqual(["a"]);
      expect(p.store.canUndo()).toBe(false);

      await saveRevision(server, id);
      const r = client(id, [9000, 9000, 9100, 9100]);
      await until(() => r.store.objects.has("extension-state"), "the stored state");
      expect(r.document.extensionState().getMap("game.test").get("score")).toBe(3);
      expect((await readCanvas(server, id)).shapes.map((shape) => shape.id)).toEqual(["a"]);
    });
  });

  describe("convergence", () => {
    it("merges concurrent edits to different keys and to the same key", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      const p = client(id);
      const q = client(id);
      await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

      p.store.write("a", [
        ["style.color", "#ff0000"],
        ["frame.x", 10],
      ]);
      q.store.write("a", [
        ["style.color", "#0000ff"],
        ["frame.y", 20],
      ]);
      await until(
        () =>
          property(p, "a", "frame.y") === 20 &&
          property(q, "a", "frame.x") === 10 &&
          property(p, "a", "style.color") === property(q, "a", "style.color"),
        "convergence",
      );
      const stored = (await readCanvas(server, id)).shapes[0];
      expect(stored.frame.x).toBe(10);
      expect(stored.frame.y).toBe(20);
      expect(stored.style.color).toBe(property(p, "a", "style.color"));
    });

    it("lands both insertions when two clients type into one text shape", async () => {
      const id = await createCanvas(server, [note("a", 0, 0, "hello")]);
      const p = client(id);
      const q = client(id);
      await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

      typeInto(p, "a", "P");
      typeInto(q, "a", "Q");
      await until(
        () => bodyText(p, "a") === bodyText(q, "a") && bodyText(p, "a").length === 7,
        "both insertions",
      );
      expect(bodyText(p, "a")).toMatch(/^(PQ|QP)hello$/);

      const r = client(id);
      await until(() => r.store.objects.has("a"), "a reload");
      expect(bodyText(r, "a")).toBe(bodyText(p, "a"));
    });
  });

  describe("summaries", () => {
    it("corrects a summary a concurrent move and resize left stale", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      const p = client(id);
      const q = client(id);
      await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

      p.store.write("a", [["frame.x", 2000]]);
      q.store.write("a", [["frame.width", 400]]);
      await until(
        () => property(p, "a", "frame.width") === 400 && property(q, "a", "frame.x") === 2000,
        "both writes",
      );
      // The merged shape spans 2000..2400; only a corrected summary covers its right end.
      await eventually(
        async () => (await loadIds(server, id, { view: [2300, 10, 2350, 50] })).includes("a"),
        "the corrected summary",
      );
    });

    it("keeps a connector's summary on its route when an endpoint moves", async () => {
      const id = await createCanvas(server, [note("a", 0, 0), note("b", 300, 0), line("c", "a", "b")]);
      const p = client(id);
      await until(() => p.store.objects.has("c"), "the connector");

      p.store.write("b", [
        ["frame.x", 3000],
        ["frame.y", 3000],
      ]);
      await eventually(
        async () => (await loadIds(server, id, { view: [1500, 1500, 1510, 1510] })).includes("c"),
        "the connector's new route",
      );
    });
  });

  describe("durability", () => {
    it("catches up by since after a dropped connection, and its unsent edit lands once", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      const p = client(id);
      const q = client(id);
      await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

      p.pause();
      q.store.write("a", [["style.color", "#00ff00"]]);
      p.store.write("a", [["frame.x", 77]]);
      await until(() => property(q, "a", "style.color") === "#00ff00", "q's own write");
      p.resume();

      await until(
        () => property(p, "a", "style.color") === "#00ff00" && property(q, "a", "frame.x") === 77,
        "catch-up and resend",
      );
      expect(p.errors).toEqual([]);
    });

    it("reloads after a revision restore, and the next edit lands", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      await saveRevision(server, id);
      const p = client(id);
      const q = client(id);
      await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

      p.store.write("a", [["frame.x", 500]]);
      await until(() => property(q, "a", "frame.x") === 500, "the edit before the restore");
      const restored = await server.api(
        `/api/v1/spaces/${server.spaceId}/documents/${id}/revisions?rev=1`,
        { method: "POST", body: "{}" },
      );
      expect(restored.status).toBe(200);
      await until(() => p.reloads() === 1 && property(p, "a", "frame.x") === 0, "the reload");

      p.store.write("a", [["frame.y", 42]]);
      await until(() => property(q, "a", "frame.y") === 42, "an edit after the restore");
    });
  });

  describe("deletion, undo and compaction", () => {
    it("deletes on undo of a creation, and brings the shape back on redo", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      const p = client(id);
      const q = client(id);
      await until(() => p.joined() && q.store.objects.has("a"), "the room");

      p.store.create("fresh", [
        ["type", "note"],
        ["frame.x", 50],
        ["frame.y", 50],
      ]);
      await until(() => q.store.live("fresh"), "the creation");
      p.store.undo();
      await until(() => !q.store.live("fresh"), "the undone creation");
      expect(await loadIds(server, id, { view: [40, 40, 60, 60] })).not.toContain("fresh");
      p.store.redo();
      await until(() => q.store.live("fresh"), "the redone creation");
    });

    it("keeps another client's colour when a recolour is undone", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      const p = client(id);
      const q = client(id);
      await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

      p.store.write("a", [["style.color", "#111111"]]);
      await until(() => property(q, "a", "style.color") === "#111111", "p's colour");
      q.store.write("a", [["style.color", "#222222"]]);
      await until(() => property(p, "a", "style.color") === "#222222", "q's colour");
      // The winning colour is no longer p's write, so the undo writes nothing.
      p.store.undo();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(property(p, "a", "style.color")).toBe("#222222");
      expect(property(q, "a", "style.color")).toBe("#222222");
    });

    it("brings a deleted shape back on undo after a base rewrite dropped it", async () => {
      const id = await createCanvas(server, [note("a", 0, 0), note("b", 300, 0)]);
      const p = client(id);
      await until(() => p.store.objects.has("a"), "the shape");

      p.store.remove("a");
      const ids = async () => (await readCanvas(server, id)).shapes.map((shape) => shape.id);
      await eventually(async () => !(await ids()).includes("a"), "the delete");
      await saveRevision(server, id);
      expect(await loadIds(server, id, { ids: ["a"] })).toEqual([]);

      p.store.undo();
      await eventually(async () => (await ids()).includes("a"), "the undone delete");
      const restored = (await readCanvas(server, id)).shapes.find((shape) => shape.id === "a");
      expect(restored?.frame.width).toBe(180);
    });

    it("keeps a shape whose last summary says deleted while its properties do not", async () => {
      const id = await createCanvas(server, [note("a", 0, 0)]);
      // Sent past any client, which would correct the summary on its echo.
      await sendRaw(server, id, {
        id: "a",
        seq: 0,
        bbox: [0, 0, 180, 120],
        refs: [],
        deleted: true,
        full: false,
        groups: [],
        body: new Uint8Array(0),
      });
      // The flag alone hides it from view loads; the rewrite must not drop it for that.
      await eventually(
        async () => !(await loadIds(server, id, { view: [-10, -10, 10, 10] })).includes("a"),
        "the stale summary",
      );
      await saveRevision(server, id);
      expect((await readCanvas(server, id)).shapes.map((shape) => shape.id)).toEqual(["a"]);
    });

    it("round-trips strokes, rotation and stamped shapes through a base rewrite", async () => {
      const id = await createCanvas(
        server,
        [{ ...note("r", 0, 0), frame: { x: 0, y: 0, width: 180, height: 120, rotation: 135 } }],
        [
          {
            id: "s",
            kind: "shape",
            rotation: 45,
            points: [
              { x: 0.5, y: 0.25, width: 4 },
              { x: 100, y: 100, width: 4 },
            ],
            style: { color: "#111111", width: 4 },
            updatedAt: 3,
          },
        ],
      );
      const p = client(id);
      await until(() => p.store.objects.has("s"), "the stroke");
      p.store.write("r", [["style.color", "#333333"]]);
      await eventually(
        async () => (await readCanvas(server, id)).shapes[0].style.color === "#333333",
        "the recolour",
      );
      await saveRevision(server, id);
      const stored = await readCanvas(server, id);
      expect(stored.shapes[0].frame.rotation).toBe(135);
      const stroke = stored.strokes[0] as unknown as {
        kind: string;
        rotation: number;
        points: { x: number; y: number }[];
      };
      expect(stroke.kind).toBe("shape");
      expect(stroke.rotation).toBe(45);
      expect(stroke.points[0]).toEqual({ x: 0.5, y: 0.25, width: 4 });
    });
  });
});

describe("canvas durability across a server crash", () => {
  const PORT = 7494;
  const dataDir = mkdtempSync(path.join(tmpdir(), "vektor-canvas-"));
  const server: Server = {
    baseUrl: testBaseUrl(PORT),
    api: createApiRequest(testBaseUrl(PORT)),
    spaceId: "",
  };
  const env = {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_API_ONLY: "1",
    VEKTOR_DATA_DIR: dataDir,
  };
  let process: TestServerProcess;
  const clients: Client[] = [];

  beforeAll(async () => {
    process = startTestServer(PORT, env);
    await waitForServer(server.baseUrl);
    const response = await server.api("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Canvas Crash", slug: "canvas-crash" }),
    });
    server.spaceId = (await response.json()).space.id;
  });

  afterAll(() => {
    for (const opened of clients) opened.close();
    process?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps every connected client's edit when the server dies before a flush", async () => {
    const id = await createCanvas(server, [note("a", 0, 0, "hello")]);
    const p = openClient(server, id, AROUND_ORIGIN);
    const q = openClient(server, id, AROUND_ORIGIN);
    clients.push(p, q);
    await until(() => p.store.objects.has("a") && q.store.objects.has("a"), "the shape");

    q.store.write("a", [["style.color", "#0000ff"]]);
    typeInto(q, "a", "Q");
    await until(() => bodyText(p, "a") === "Qhello", "q's typing");
    q.close();
    p.store.write("a", [["style.color", "#ff0000"]]);
    typeInto(p, "a", "P");
    await until(() => property(p, "a", "style.color") === "#ff0000", "p's colour");

    // Inside the flush delay: nothing since the last flush is durable.
    (process as unknown as { kill(signal?: number): void }).kill(9);
    process = startTestServer(PORT, env);
    await waitForServer(server.baseUrl);

    // P reconnects, catches up and resends; P held Q's typing, so its whole body brings both back.
    await eventually(async () => {
      const shape = (await readCanvas(server, id)).shapes[0];
      return shape.style.color === "#ff0000" && shape.data.text === "PQhello";
    }, "p's resent edits", 20_000);
  });

  it("migrates a JSON canvas and its revisions to bases at startup", async () => {
    const shapes = [note("m1", 0, 0, "migrated **text**"), note("m2", 400, 0), line("m3", "m1", "m2")];
    const strokes = [
      {
        id: "ms",
        points: [
          { x: 1000, y: 1000, width: 4 },
          { x: 1010, y: 1005, width: 4 },
        ],
        style: { color: "#111827", width: 4 },
        updatedAt: 5,
      },
    ];
    const id = await createCanvas(server, []);
    await saveRevision(server, id);
    process.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The row and the revision as the previous version stored them: JSON, and brotli JSON.
    const json = JSON.stringify({ version: 1, shapes, strokes });
    const database = new Database(path.join(dataDir, "spaces", `${server.spaceId}.db`));
    database.run("UPDATE document SET content = ?, content_key = NULL WHERE id = ?", [json, id]);
    database.run("UPDATE revision SET snapshot = ?, checksum = 'legacy' WHERE document_id = ?", [
      brotliCompressSync(Buffer.from(json)),
      id,
    ]);
    database.close();

    process = startTestServer(PORT, env);
    await waitForServer(server.baseUrl);

    const stored = await readCanvas(server, id);
    expect(stored.shapes.map((shape) => shape.id).sort()).toEqual(["m1", "m2", "m3"]);
    expect(stored.shapes.find((shape) => shape.id === "m1")?.data.text).toBe("migrated **text**");
    expect(stored.strokes.map((stroke) => stroke.id)).toEqual(["ms"]);
    expect(await loadIds(server, id, { view: [-10, -10, 10, 10] })).toEqual(["m1", "m2", "m3"]);
    const revision = await server.api(
      `/api/v1/spaces/${server.spaceId}/documents/${id}?rev=1`,
    );
    expect(JSON.parse((await revision.json()).revision.content).shapes).toHaveLength(3);

    const migrated = new Database(path.join(dataDir, "spaces", `${server.spaceId}.db`));
    const row = migrated
      .query<{ content_key: string; content: string }, [string]>(
        "SELECT content_key, content FROM document WHERE id = ?",
      )
      .get(id);
    migrated.close();
    expect(row?.content_key).toMatch(/\/base-[0-9a-f-]+\.vcanvas$/);
    expect(row?.content).toBe("");
  });
});
