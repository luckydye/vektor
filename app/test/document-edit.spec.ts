import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  WsMsgType,
  wsDecode,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "#utils/realtime.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7477;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let testSpaceId: string;

async function createDocument(content: string, type?: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      content,
      properties: { title: "Edit Test" },
      ...(type ? { type } : {}),
    }),
  });
  expect(response.status).toBe(201);
  const data = await response.json();
  return data.document.id;
}

async function readContent(documentId: string, query = ""): Promise<string> {
  const response = await apiRequest(
    `/api/v1/spaces/${testSpaceId}/documents/${documentId}${query}`,
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  return data.document.content;
}

async function editDocument(
  documentId: string,
  operations: unknown[],
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${documentId}/edit`, {
    method: "POST",
    body: JSON.stringify({ operations }),
  });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
  });

  await waitForServer(BASE_URL);

  const response = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Edit Test Space", slug: "edit-test" }),
  });
  expect(response.status).toBe(201);
  testSpaceId = (await response.json()).space.id;
});

afterAll(() => {
  serverProcess?.kill();
});

describe("Document edit operations", () => {
  it("applies line operations without a live room", async () => {
    const documentId = await createDocument("<h1>Title</h1>\n<p>one</p>\n<p>two</p>");

    let response = await editDocument(documentId, [
      { op: "insert", line: "2", content: "<p>inserted</p>" },
    ]);
    expect(response.status).toBe(200);
    expect((await response.json()).live).toBe(false);
    expect(await readContent(documentId)).toBe(
      "<h1>Title</h1>\n<p>inserted</p>\n<p>one</p>\n<p>two</p>",
    );

    response = await editDocument(documentId, [
      { op: "replace", range: "3:4", content: "<p>replaced</p>" },
      { op: "delete", range: "2" },
    ]);
    expect(response.status).toBe(200);
    expect(await readContent(documentId)).toBe("<h1>Title</h1>\n<p>replaced</p>");

    response = await editDocument(documentId, [
      { op: "insert", line: "$", content: "<p>appended</p>" },
    ]);
    expect(response.status).toBe(200);
    expect(await readContent(documentId)).toBe(
      "<h1>Title</h1>\n<p>replaced</p>\n<p>appended</p>",
    );
  });

  it("normalizes compact single-line html for line edits and live reads", async () => {
    const documentId = await createDocument("<h1>Title</h1><p>one</p><p>two</p>");

    // Live read splits compact content into one block per line.
    expect(await readContent(documentId, "?live=true")).toBe(
      "<h1>Title</h1>\n<p>one</p>\n<p>two</p>",
    );

    // Line edits operate on the same normalized structure.
    const response = await editDocument(documentId, [{ op: "delete", range: "2" }]);
    expect(response.status).toBe(200);
    expect(await readContent(documentId)).toBe("<h1>Title</h1>\n<p>two</p>");
  });

  it("applies regex substitutions and preserves unicode", async () => {
    const documentId = await createDocument(
      "<p>Antworte mit&nbsp;🔴 ROT oder 🟢 GRÜN für die Seite.</p>\n" +
        '<p><user-mention email="t@v.de">@Tim</user-mention> is cool.</p>',
    );

    const response = await editDocument(documentId, [
      { op: "sub", pattern: "<user-mention[^>]*>.*?</user-mention>", replacement: "" },
    ]);
    expect(response.status).toBe(200);

    const content = await readContent(documentId);
    expect(content).not.toContain("user-mention");
    expect(content).toContain("🔴 ROT oder 🟢 GRÜN für die Seite");
    expect(content).toContain("<p> is cool.</p>");

    // A pattern that matches nothing fails loudly instead of pretending success.
    const miss = await editDocument(documentId, [
      { op: "sub", pattern: "does-not-exist-anywhere", replacement: "x" },
    ]);
    expect(miss.status).toBe(400);
  });

  it("applies json operations", async () => {
    const documentId = await createDocument(
      JSON.stringify({ config: { timeout: 10 }, items: [1, 2] }),
    );

    const response = await editDocument(documentId, [
      { op: "set", path: ".config.timeout", value: 30 },
      { op: "push", path: ".items", value: { name: "new" } },
      { op: "unset", path: ".items[0]" },
    ]);
    expect(response.status).toBe(200);
    expect(JSON.parse(await readContent(documentId))).toEqual({
      config: { timeout: 30 },
      items: [2, { name: "new" }],
    });
  });

  it("rejects invalid operations", async () => {
    const documentId = await createDocument("<p>one</p>");

    expect((await editDocument(documentId, [{ op: "delete", range: "9" }])).status).toBe(
      400,
    );
    expect((await editDocument(documentId, [{ op: "nope" }])).status).toBe(400);
    expect(
      (await editDocument(documentId, [{ op: "set", path: ".a", value: 1 }])).status,
    ).toBe(400);
  });

  it("applies edits through a live Yjs room and broadcasts to clients", async () => {
    const documentId = await createDocument("<h1>Title</h1>\n<p>one</p>\n<p>two</p>");

    const ws = new WebSocket(`${BASE_URL.replace("http", "ws")}/events/${testSpaceId}`);
    ws.binaryType = "arraybuffer";

    const frames: { type: number; payload: Uint8Array }[] = [];
    const waitForFrame = (type: number): Promise<Uint8Array> =>
      new Promise((resolve, reject) => {
        const existing = frames.find((frame) => frame.type === type);
        if (existing) {
          frames.splice(frames.indexOf(existing), 1);
          resolve(existing.payload);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for frame ${type}`)),
          5000,
        );
        const check = (frame: { type: number; payload: Uint8Array }) => {
          if (frame.type === type) {
            clearTimeout(timer);
            frames.splice(frames.indexOf(frame), 1);
            resolve(frame.payload);
            return true;
          }
          return false;
        };
        pendingChecks.push(check);
      });
    const pendingChecks: ((frame: { type: number; payload: Uint8Array }) => boolean)[] =
      [];

    ws.addEventListener("message", (event) => {
      const frame = wsDecode(new Uint8Array(event.data as ArrayBuffer));
      for (let i = 0; i < pendingChecks.length; i++) {
        if (pendingChecks[i]?.(frame)) {
          pendingChecks.splice(i, 1);
          return;
        }
      }
      frames.push(frame);
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket error")));
    });

    // Join the collaboration room and load the initial state.
    ws.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
    const statePayload = await waitForFrame(WsMsgType.YjsUpdate);
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, wsDecodeYjsUpdate(statePayload).update);

    // Concurrent client edit: append a paragraph through the websocket.
    const stateBefore = Y.encodeStateVector(clientDoc);
    const fragment = clientDoc.getXmlFragment("default");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("from client")]);
    fragment.push([paragraph]);
    ws.send(wsEncodeYjsUpdate(documentId, Y.encodeStateAsUpdate(clientDoc, stateBefore)));
    // Give the server a moment to apply the websocket update to the room.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Server-side edit through the edit endpoint; must merge, not overwrite.
    const response = await editDocument(documentId, [
      { op: "replace", range: "2", content: "<p>EDITED</p>" },
    ]);
    expect(response.status).toBe(200);
    expect((await response.json()).live).toBe(true);

    // The edit is broadcast to connected clients as a Yjs update.
    const broadcastPayload = await waitForFrame(WsMsgType.YjsUpdate);
    Y.applyUpdate(clientDoc, wsDecodeYjsUpdate(broadcastPayload).update);

    // The edit carries a presence cursor for "Agent" over the edited blocks.
    const presencePayload = await waitForFrame(WsMsgType.PresenceUpdate);
    const { presence } = JSON.parse(new TextDecoder().decode(presencePayload)) as {
      presence: {
        room: string;
        clientId: string;
        user: { id: string; name: string };
        state: { kind: string; selection: { anchor: object; head: object } | null };
      };
    };
    expect(presence.clientId).toBe("agent");
    expect(presence.user.name).toBe("Agent");
    expect(presence.room).toBe(documentId);
    expect(presence.state.kind).toBe("editor");
    expect(presence.state.selection).not.toBeNull();
    // The positions must be valid Yjs relative positions in the shared doc.
    const anchor = Y.createRelativePositionFromJSON(presence.state.selection?.anchor);
    const head = Y.createRelativePositionFromJSON(presence.state.selection?.head);
    expect(
      Y.createAbsolutePositionFromRelativePosition(anchor, clientDoc),
    ).not.toBeNull();
    expect(Y.createAbsolutePositionFromRelativePosition(head, clientDoc)).not.toBeNull();

    const persisted = await readContent(documentId);
    expect(persisted).toContain("<p>EDITED</p>");
    expect(persisted).toContain("from client");
    expect(persisted).not.toContain("<p>one</p>");

    // A live read (?live=true) reflects unsaved collaborative changes, so
    // line references stay consistent with what edit operations act on.
    const unsavedStateBefore = Y.encodeStateVector(clientDoc);
    const unsaved = new Y.XmlElement("paragraph");
    unsaved.insert(0, [new Y.XmlText("unsaved change")]);
    fragment.push([unsaved]);
    ws.send(
      wsEncodeYjsUpdate(documentId, Y.encodeStateAsUpdate(clientDoc, unsavedStateBefore)),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(await readContent(documentId, "?live=true")).toContain("unsaved change");
    expect(await readContent(documentId)).not.toContain("unsaved change");

    ws.close();
  });

  it("applies canvas edits through a live Yjs room", async () => {
    const documentId = await createDocument(
      JSON.stringify({
        version: 1,
        shapes: [
          {
            id: "shape-1",
            type: "note",
            x: 0,
            y: 0,
            width: 240,
            height: 150,
            text: "existing",
            color: "#fef3c7",
            updatedAt: 1,
          },
        ],
        strokes: [],
      }),
      "canvas",
    );

    const ws = new WebSocket(`${BASE_URL.replace("http", "ws")}/events/${testSpaceId}`);
    ws.binaryType = "arraybuffer";
    const received: Uint8Array[] = [];
    const presenceFrames: Uint8Array[] = [];
    ws.addEventListener("message", (event) => {
      const frame = wsDecode(new Uint8Array(event.data as ArrayBuffer));
      if (frame.type === WsMsgType.YjsUpdate) received.push(frame.payload);
      else if (frame.type === WsMsgType.PresenceUpdate)
        presenceFrames.push(frame.payload);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket error")));
    });

    ws.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
    while (received.length < 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, wsDecodeYjsUpdate(received[0]!).update);

    // Push a new note shape through the edit endpoint while the room is open.
    const response = await editDocument(documentId, [
      {
        op: "push",
        path: ".shapes",
        value: {
          id: "shape-story",
          type: "note",
          x: 300,
          y: 100,
          width: 240,
          height: 150,
          text: "a short story",
          color: "#fff7ed",
          updatedAt: 2,
        },
      },
      { op: "set", path: ".shapes[0].text", value: "updated" },
    ]);
    expect(response.status).toBe(200);
    expect((await response.json()).live).toBe(true);

    // The change is broadcast to the connected client as a Yjs update.
    while (received.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    for (const payload of received.slice(1)) {
      Y.applyUpdate(clientDoc, wsDecodeYjsUpdate(payload).update);
    }
    const clientShapes = clientDoc.getMap<Y.Map<unknown>>("canvas.shapes");
    expect(clientShapes.get("shape-story")?.get("text")).toBe("a short story");
    expect(clientShapes.get("shape-1")?.get("text")).toBe("updated");

    // Persisted and live content both reflect the edit.
    const persisted = JSON.parse(await readContent(documentId));
    expect(persisted.shapes.map((shape: { id: string }) => shape.id).sort()).toEqual([
      "shape-1",
      "shape-story",
    ]);
    expect(JSON.parse(await readContent(documentId, "?live=true")).shapes).toHaveLength(
      2,
    );

    // An "Agent" canvas presence is broadcast, pointing at the changed shapes.
    while (presenceFrames.length < 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const { presence } = JSON.parse(
      new TextDecoder().decode(presenceFrames[presenceFrames.length - 1]!),
    ) as {
      presence: {
        clientId: string;
        user: { name: string };
        state: {
          kind: string;
          pointer: { x: number; y: number } | null;
          selectionIds: string[];
        };
      };
    };
    expect(presence.clientId).toBe("agent");
    expect(presence.user.name).toBe("Agent");
    expect(presence.state.kind).toBe("canvas");
    expect(presence.state.pointer).not.toBeNull();
    expect(presence.state.selectionIds).toContain("shape-story");

    ws.close();
  });
});
