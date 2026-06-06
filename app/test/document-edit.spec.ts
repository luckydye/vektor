import { beforeAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  WsMsgType,
  wsDecode,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "../src/utils/realtime.ts";

const BASE_URL = process.env.VEKTOR_TEST_URL ?? "http://127.0.0.1:4321";

let sessionToken: string;
let testSpaceId: string;

async function createTestUser() {
  const testEmail = `test-edit-${Date.now()}-${Math.random()}@example.com`;
  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: "TestPassword123!",
      name: "Edit Tester",
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.statusText}`);
  }
  const data = await response.json();
  const cookies = response.headers.get("set-cookie");
  const match = cookies?.match(/better-auth\.session_token=([^;]+)/);
  return match
    ? match[1]!
    : `${data.token}.${Buffer.from(data.token).toString("base64")}`;
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function createDocument(content: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content, properties: { title: "Edit Test" } }),
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
  sessionToken = await createTestUser();
  const response = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Edit Test Space", slug: `edit-test-${Date.now()}` }),
  });
  expect(response.status).toBe(201);
  testSpaceId = (await response.json()).space.id;
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

    const ws = new WebSocket(`${BASE_URL.replace("http", "ws")}/events/${testSpaceId}`, {
      headers: { Cookie: `better-auth.session_token=${sessionToken}` },
    });
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
        if (pendingChecks[i]!(frame)) {
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
    const anchor = Y.createRelativePositionFromJSON(presence.state.selection!.anchor);
    const head = Y.createRelativePositionFromJSON(presence.state.selection!.head);
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
});
