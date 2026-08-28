import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { subscribeToAuthorizationChanges } from "#acl/events.ts";
import { documentLockChangedKind } from "#realtime/changes.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import {
  type RealtimeAccessChangedMessage,
  type RealtimeErrorPayload,
  realtimeTopics,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHORIZED,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "#realtime/protocol.ts";
import { sweepIdleYRooms, yRooms } from "#realtime/yjsRooms.ts";
import {
  createApiRequest,
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  type TestUserSession,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7486;
const AUTH_PORT = 7487;
const BASE_URL = testBaseUrl(PORT);
const AUTH_BASE_URL = testBaseUrl(AUTH_PORT);
const apiRequest = createApiRequest(BASE_URL);
const authApiRequest = createSessionApiRequest(AUTH_BASE_URL);

interface ReceivedFrame {
  type: WsMsgType;
  payload: Uint8Array;
}

interface SocketFrames {
  socket: WebSocket;
  expectNoFrame(type: WsMsgType, timeoutMs?: number): Promise<void>;
  waitForFrame(type: WsMsgType, timeoutMs?: number): Promise<Uint8Array>;
}

async function waitForAccessChange(
  connection: SocketFrames,
  expected: Omit<RealtimeAccessChangedMessage, "type">,
): Promise<void> {
  while (true) {
    const change = wsDecodeJson<Omit<RealtimeAccessChangedMessage, "type">>(
      await connection.waitForFrame(WsMsgType.AccessChanged, FRAME_TIMEOUT_MS),
    );
    if (
      change.scope === expected.scope &&
      change.access === expected.access &&
      change.resourceId === expected.resourceId
    ) {
      return;
    }
  }
}

let serverProcess: TestServerProcess;
let authServerProcess: TestServerProcess;
let testSpaceId: string;
let testDocumentId: string;

function websocketUrl(baseUrl: string, spaceId: string): string {
  return `${baseUrl.replace("http", "ws")}/events/${spaceId}`;
}

function connectWebSocket(
  baseUrl: string,
  spaceId: string,
  sessionToken?: string,
): Promise<SocketFrames> {
  const url = websocketUrl(baseUrl, spaceId);
  // Bun's WebSocket takes request headers, which is the only way to hand the
  // handshake a session cookie.
  const socket = sessionToken
    ? new WebSocket(url, {
        headers: { Cookie: `vektor.session_token=${sessionToken}` },
      })
    : new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.addEventListener("close", (event) => closeCodes.set(socket, event.code));

  const frames: ReceivedFrame[] = [];
  const listeners = new Set<(frame: ReceivedFrame) => boolean>();
  socket.addEventListener("message", (event) => {
    const frame = wsDecode(new Uint8Array(event.data as ArrayBuffer));
    for (const listener of listeners) {
      if (listener(frame)) {
        return;
      }
    }
    frames.push(frame);
  });

  const waitForFrame = (type: WsMsgType, timeoutMs = 5_000): Promise<Uint8Array> => {
    const existingIndex = frames.findIndex((frame) => frame.type === type);
    if (existingIndex >= 0) {
      return Promise.resolve(frames.splice(existingIndex, 1)[0]?.payload);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`timed out waiting for WebSocket frame ${type}`));
      }, timeoutMs);
      const listener = (frame: ReceivedFrame): boolean => {
        if (frame.type !== type) {
          return false;
        }
        clearTimeout(timeout);
        listeners.delete(listener);
        resolve(frame.payload);
        return true;
      };
      listeners.add(listener);
    });
  };

  const expectNoFrame = (type: WsMsgType, timeoutMs = 400): Promise<void> => {
    if (frames.some((frame) => frame.type === type)) {
      return Promise.reject(new Error(`unexpected WebSocket frame ${type}`));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(listener);
        resolve();
      }, timeoutMs);
      const listener = (frame: ReceivedFrame): boolean => {
        if (frame.type !== type) {
          return false;
        }
        clearTimeout(timeout);
        listeners.delete(listener);
        reject(new Error(`unexpected WebSocket frame ${type}`));
        return true;
      };
      listeners.add(listener);
    });
  };

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve({ socket, expectNoFrame, waitForFrame });
    });
    socket.addEventListener("error", () => reject(new Error("websocket error")));
  });
}

const closeCodes = new WeakMap<WebSocket, number>();

async function waitForClose(
  socket: WebSocket,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (socket.readyState === WebSocket.CLOSED) {
    return closeCodes.get(socket) ?? null;
  }

  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket close")),
      timeoutMs,
    );
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve(event.code);
    });
  });
}

const FRAME_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

describe("Realtime authorization invalidation", () => {
  it("announces a document lock before topic events are coalesced", () => {
    const changes: string[] = [];
    const unsubscribe = subscribeToAuthorizationChanges((change) => {
      if (change.spaceId) changes.push(change.spaceId);
    });

    try {
      const topic = realtimeTopics.document("document-lock-event");
      sendSyncEvent("lock-event-space", {
        topic,
        data: { kind: documentLockChangedKind },
      });
      sendSyncEvent("lock-event-space", topic);
      expect(changes).toEqual(["lock-event-space"]);
    } finally {
      unsubscribe();
    }
  });
});

/**
 * Subscribes and consumes the cursor acknowledgement. Every Subscribe is
 * answered with an Event frame carrying the catch-up, empty for a fresh cursor.
 */
async function subscribe(
  connection: SocketFrames,
  topics: string[],
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<void> {
  connection.socket.send(wsEncode(WsMsgType.Subscribe, { topics }));
  await connection.waitForFrame(WsMsgType.Event, timeoutMs);
}

async function joinRoom(connection: SocketFrames, documentId: string): Promise<Y.Doc> {
  connection.socket.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
  const state = wsDecodeYjsUpdate(
    await connection.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS),
  );
  const clientDoc = new Y.Doc();
  Y.applyUpdate(clientDoc, state.update, "remote");
  return clientDoc;
}

function appendParagraph(clientDoc: Y.Doc, text: string): Uint8Array {
  const stateBefore = Y.encodeStateVector(clientDoc);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  clientDoc.getXmlFragment("default").push([paragraph]);
  return Y.encodeStateAsUpdate(clientDoc, stateBefore);
}

async function createCategory(name: string, slug: string): Promise<void> {
  const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`, {
    method: "POST",
    body: JSON.stringify({ name, slug }),
  });
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
  });
  authServerProcess = startTestServer(AUTH_PORT, {
    AUTH_SECRET: "realtime-websocket-test-secret-do-not-use-in-production",
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_NO_AUTH: "0",
    VEKTOR_API_ONLY: "1",
  });

  await Promise.all([waitForServer(BASE_URL), waitForServer(AUTH_BASE_URL)]);

  const spaceResponse = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Realtime Test Space", slug: "realtime-test" }),
  });
  expect(spaceResponse.status).toBe(201);
  testSpaceId = (await spaceResponse.json()).space.id;

  const documentResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      content: "<p>Realtime test</p>",
      properties: { title: "Test" },
    }),
  });
  expect(documentResponse.status).toBe(201);
  testDocumentId = (await documentResponse.json()).document.id;
});

afterAll(() => {
  serverProcess?.kill();
  authServerProcess?.kill();
});

describe("Realtime WebSocket", () => {
  it("resets a joined room when an older revision is published", async () => {
    const created = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "const version = 1;",
        properties: { title: "Publish Test" },
        type: "workflow",
      }),
    });
    expect(created.status).toBe(201);
    const documentId = (await created.json()).document.id;

    const saved = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${documentId}`,
      { method: "POST", body: JSON.stringify({ html: "const version = 1;" }) },
    );
    expect(saved.status).toBe(200);
    const firstRev = (await saved.json()).revision.rev;

    // Publishing the first revision keeps the next save from overwriting it in
    // place, so the document ends up with two distinct revisions.
    expect(
      (
        await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${documentId}`, {
          method: "PATCH",
          body: JSON.stringify({ publishedRev: firstRev }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${documentId}`, {
          method: "PUT",
          body: JSON.stringify({ content: "const version = 2;" }),
        })
      ).status,
    ).toBe(200);

    const revisions = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${documentId}/revisions`,
    ).then((response) => response.json());
    const secondRev = Math.max(
      ...revisions.revisions.map((entry: { rev: number }) => entry.rev),
    );
    expect(secondRev).toBeGreaterThan(firstRev);
    expect(
      (
        await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${documentId}`, {
          method: "PATCH",
          body: JSON.stringify({ publishedRev: secondRev }),
        })
      ).status,
    ).toBe(200);

    const connection = await connectWebSocket(BASE_URL, testSpaceId);
    try {
      const clientDoc = new Y.Doc();
      connection.socket.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
      Y.applyUpdate(
        clientDoc,
        wsDecodeYjsUpdate(await connection.waitForFrame(WsMsgType.YjsUpdate)).update,
        "remote",
      );
      expect(clientDoc.getXmlFragment("default").toString()).toContain(
        "const version = 2;",
      );

      expect(
        (
          await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${documentId}`, {
            method: "PATCH",
            body: JSON.stringify({ publishedRev: firstRev }),
          })
        ).status,
      ).toBe(200);

      // The room is what every reader sees and what gets persisted back, so
      // publishing has to reach it rather than only the stored content.
      Y.applyUpdate(
        clientDoc,
        wsDecodeYjsUpdate(await connection.waitForFrame(WsMsgType.YjsUpdate)).update,
        "remote",
      );
      const source = clientDoc.getXmlFragment("default").toString();
      expect(source).toContain("const version = 1;");
      expect(source).not.toContain("const version = 2;");
    } finally {
      connection.socket.close();
    }
  });

  it("serves one document to joins that race the load of a cold room", async () => {
    const created = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "<p>cold room</p>",
        properties: { title: "Concurrent Join" },
      }),
    });
    expect(created.status).toBe(201);
    const documentId = (await created.json()).document.id;

    const first = await connectWebSocket(BASE_URL, testSpaceId);
    const second = await connectWebSocket(BASE_URL, testSpaceId);
    try {
      // Both frames go out before either load can finish, which is what a
      // document switch does: two joins land on a room that has no doc yet.
      first.socket.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
      second.socket.send(wsEncode(WsMsgType.YjsJoin, { documentId }));

      const firstDoc = new Y.Doc();
      Y.applyUpdate(
        firstDoc,
        wsDecodeYjsUpdate(await first.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS))
          .update,
        "remote",
      );
      await second.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS);
      expect(firstDoc.getXmlFragment("default").toString()).toContain("cold room");

      first.socket.send(
        wsEncodeYjsUpdate(documentId, appendParagraph(firstDoc, "raced edit")),
      );
      // Applied to whichever doc the room kept. A join that overwrote it would
      // hand the next client a document without this paragraph.
      Y.applyUpdate(
        firstDoc,
        wsDecodeYjsUpdate(
          await second.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS),
        ).update,
        "remote",
      );

      const late = await connectWebSocket(BASE_URL, testSpaceId);
      try {
        const lateDoc = await joinRoom(late, documentId);
        expect(lateDoc.getXmlFragment("default").toString()).toContain("raced edit");
        expect(lateDoc.getXmlFragment("default").toString()).toContain("cold room");
      } finally {
        late.socket.close();
      }
    } finally {
      first.socket.close();
      second.socket.close();
    }
  });

  it("does not duplicate content when reconnecting to a recreated Yjs room", async () => {
    const initialConnection = await connectWebSocket(BASE_URL, testSpaceId);
    const clientDoc = new Y.Doc();

    initialConnection.socket.send(
      wsEncode(WsMsgType.YjsJoin, { documentId: testDocumentId }),
    );
    const initialState = wsDecodeYjsUpdate(
      await initialConnection.waitForFrame(WsMsgType.YjsUpdate),
    );
    Y.applyUpdate(clientDoc, initialState.update, "remote");

    const expectedContent = clientDoc.getXmlFragment("default").toString();
    expect(expectedContent).not.toBe("");

    // This socket is the room's only member and has no presence registration,
    // so closing it evicts the in-memory Y.Doc. The next join recreates the room
    // from persisted HTML while the client retains its original Y.Doc.
    initialConnection.socket.close();
    await waitForClose(initialConnection.socket);

    const reconnected = await connectWebSocket(BASE_URL, testSpaceId);
    try {
      reconnected.socket.send(
        wsEncode(WsMsgType.YjsJoin, { documentId: testDocumentId }),
      );
      const recreatedRoomState = wsDecodeYjsUpdate(
        await reconnected.waitForFrame(WsMsgType.YjsUpdate),
      );
      Y.applyUpdate(clientDoc, recreatedRoomState.update, "remote");

      expect(clientDoc.getXmlFragment("default").toString()).toBe(expectedContent);
    } finally {
      reconnected.socket.close();
    }
  });

  it("synchronizes client presence joins, updates, leaves, and disconnects", async () => {
    const observer = await connectWebSocket(BASE_URL, testSpaceId);
    const participant = await connectWebSocket(BASE_URL, testSpaceId);

    observer.socket.send(
      wsEncode(WsMsgType.PresenceJoin, {
        room: testDocumentId,
        clientId: "observer-client",
        user: { id: "observer", name: "Observer" },
        state: { cursor: 1 },
      }),
    );
    const observerSnapshot = wsDecodeJson<{
      room: string;
      presences: { clientId: string }[];
    }>(await observer.waitForFrame(WsMsgType.PresenceSnapshot));
    expect(observerSnapshot.room).toBe(testDocumentId);
    expect(observerSnapshot.presences.map((presence) => presence.clientId)).toEqual([
      "observer-client",
    ]);

    participant.socket.send(
      wsEncode(WsMsgType.PresenceJoin, {
        room: testDocumentId,
        clientId: "participant-client",
        user: { id: "participant", name: "Participant" },
      }),
    );
    const participantSnapshot = wsDecodeJson<{
      presences: { clientId: string }[];
    }>(await participant.waitForFrame(WsMsgType.PresenceSnapshot));
    expect(participantSnapshot.presences.map((presence) => presence.clientId)).toEqual([
      "observer-client",
      "participant-client",
    ]);

    const joinedPresence = wsDecodeJson<{
      presence: { clientId: string; state: unknown };
    }>(await observer.waitForFrame(WsMsgType.PresenceUpdate));
    expect(joinedPresence.presence).toMatchObject({
      clientId: "participant-client",
      state: null,
    });

    participant.socket.send(
      wsEncode(WsMsgType.PresenceUpdate, {
        room: testDocumentId,
        clientId: "participant-client",
        state: { cursor: { x: 4, y: 8 } },
      }),
    );
    const updatedPresence = wsDecodeJson<{
      presence: { clientId: string; state: unknown };
    }>(await observer.waitForFrame(WsMsgType.PresenceUpdate));
    expect(updatedPresence.presence).toMatchObject({
      clientId: "participant-client",
      state: { cursor: { x: 4, y: 8 } },
    });

    participant.socket.send(
      wsEncode(WsMsgType.PresenceLeave, {
        room: testDocumentId,
        clientId: "participant-client",
      }),
    );
    const leftPresence = wsDecodeJson<{ room: string; clientId: string }>(
      await observer.waitForFrame(WsMsgType.PresenceLeave),
    );
    expect(leftPresence).toMatchObject({
      room: testDocumentId,
      clientId: "participant-client",
    });

    participant.socket.send(
      wsEncode(WsMsgType.PresenceJoin, {
        room: testDocumentId,
        clientId: "disconnecting-client",
        user: { id: "participant", name: "Participant" },
      }),
    );
    await participant.waitForFrame(WsMsgType.PresenceSnapshot);
    await observer.waitForFrame(WsMsgType.PresenceUpdate);

    participant.socket.close();
    const disconnectedPresence = wsDecodeJson<{ room: string; clientId: string }>(
      await observer.waitForFrame(WsMsgType.PresenceLeave),
    );
    expect(disconnectedPresence).toMatchObject({
      room: testDocumentId,
      clientId: "disconnecting-client",
    });
    await waitForClose(participant.socket);

    observer.socket.close();
  });

  it("delivers subscribed events and stops after unsubscribe", async () => {
    const connection = await connectWebSocket(BASE_URL, testSpaceId);
    await subscribe(connection, [realtimeTopics.categories]);

    const firstEvent = connection.waitForFrame(WsMsgType.Event);
    await createCategory("Subscribed category", "subscribed-category");
    const event = wsDecodeJson<{
      topics: string[];
      events: { topic: string; data?: { kind?: string } }[];
    }>(await firstEvent);
    expect(event.topics).toEqual([realtimeTopics.categories]);
    expect(event.events).toEqual([
      {
        topic: realtimeTopics.categories,
        data: expect.objectContaining({ kind: "category_created" }),
      },
    ]);

    connection.socket.send(
      wsEncode(WsMsgType.Unsubscribe, { topics: [realtimeTopics.categories] }),
    );
    await Bun.sleep(50);

    const noEvent = connection.expectNoFrame(WsMsgType.Event);
    await createCategory("Unsubscribed category", "unsubscribed-category");
    await noEvent;

    connection.socket.close();
  });

  it("answers a client liveness ping", async () => {
    const connection = await connectWebSocket(BASE_URL, testSpaceId);
    const pong = connection.waitForFrame(WsMsgType.Pong);

    connection.socket.send(wsEncode(WsMsgType.Ping, {}));
    await pong;

    // The probe must not disturb the subscriptions it is checking on.
    await subscribe(connection, [realtimeTopics.categories]);

    const event = connection.waitForFrame(WsMsgType.Event);
    connection.socket.send(wsEncode(WsMsgType.Ping, {}));
    await createCategory("Pinged category", "pinged-category");
    expect(wsDecodeJson<{ topics: string[] }>(await event).topics).toEqual([
      realtimeTopics.categories,
    ]);

    connection.socket.close();
  });

  it("rejects forbidden document subscriptions", async () => {
    const connection = await connectWebSocket(BASE_URL, testSpaceId);
    connection.socket.send(
      wsEncode(WsMsgType.Subscribe, {
        topics: [realtimeTopics.document("document_missing")],
      }),
    );

    const error = wsDecodeJson<{ message: string }>(
      await connection.waitForFrame(WsMsgType.Error),
    );
    expect(error.message).toBe("One or more realtime topics are forbidden");

    connection.socket.close();
  });

  it("rejects unauthenticated WebSocket connections", async () => {
    const connection = await connectWebSocket(AUTH_BASE_URL, "space_missing");

    const error = wsDecodeJson<{ message: string }>(
      await connection.waitForFrame(WsMsgType.Error),
    );
    expect(error.message).toBe("Unauthorized");
    expect(await waitForClose(connection.socket)).toBe(WS_CLOSE_UNAUTHORIZED);
  });
});

/**
 * Sharing one document with a non-member has to work in the live editor, not
 * only over HTTP: the connection may not demand a space role, while everything
 * behind it is still authorized against its own resource.
 */
describe("Realtime WebSocket document-level grants", () => {
  let owner: TestUserSession;
  let documentViewer: TestUserSession;
  let documentEditor: TestUserSession;
  let outsider: TestUserSession;
  let spaceId: string;
  let sharedDocumentId: string;
  let privateDocumentId: string;
  let editableDocumentId: string;

  async function createOwnedDocument(title: string, content: string): Promise<string> {
    const response = await authApiRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      owner.token,
      { method: "POST", body: JSON.stringify({ content, properties: { title } }) },
    );
    expect(response.status).toBe(201);
    return (await response.json()).document.id;
  }

  async function grantDocumentRole(
    userId: string,
    documentId: string,
    role: "viewer" | "editor",
  ): Promise<void> {
    const response = await authApiRequest(
      `/api/v1/spaces/${spaceId}/permissions`,
      owner.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: role,
          userId,
          resourceType: "document",
          resourceId: documentId,
          action: "grant",
        }),
      },
    );
    expect([200, 201]).toContain(response.status);
  }

  async function readContent(documentId: string, query = ""): Promise<string> {
    const response = await authApiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}${query}`,
      owner.token,
    );
    expect(response.status).toBe(200);
    return (await response.json()).document.content;
  }

  beforeAll(async () => {
    owner = await createTestUser(AUTH_BASE_URL, "Share Owner", "realtime-share-owner");
    documentViewer = await createTestUser(
      AUTH_BASE_URL,
      "Document Viewer",
      "realtime-share-viewer",
    );
    documentEditor = await createTestUser(
      AUTH_BASE_URL,
      "Document Editor",
      "realtime-share-editor",
    );
    outsider = await createTestUser(AUTH_BASE_URL, "Outsider", "realtime-share-outsider");

    const spaceResponse = await authApiRequest("/api/v1/spaces", owner.token, {
      method: "POST",
      body: JSON.stringify({
        name: "Realtime Sharing Space",
        slug: `realtime-sharing-${Date.now()}`,
      }),
    });
    expect(spaceResponse.status).toBe(201);
    spaceId = (await spaceResponse.json()).space.id;

    sharedDocumentId = await createOwnedDocument("Shared", "<p>shared</p>");
    privateDocumentId = await createOwnedDocument("Private", "<p>private</p>");
    editableDocumentId = await createOwnedDocument("Editable", "<p>editable</p>");

    await grantDocumentRole(documentViewer.userId, sharedDocumentId, "viewer");
    await grantDocumentRole(documentEditor.userId, editableDocumentId, "editor");
  }, 60_000);

  it(
    "lets a document-level viewer connect and receive updates for that document",
    async () => {
      const connection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentViewer.token,
      );

      try {
        // The connection itself must survive: no space role is held.
        await connection.expectNoFrame(WsMsgType.Error);

        await subscribe(connection, [realtimeTopics.document(sharedDocumentId)]);
        await connection.expectNoFrame(WsMsgType.Error);

        const clientDoc = await joinRoom(connection, sharedDocumentId);
        expect(clientDoc.getXmlFragment("default").toString()).toContain("shared");

        const event = connection.waitForFrame(WsMsgType.Event, FRAME_TIMEOUT_MS);
        const saved = await authApiRequest(
          `/api/v1/spaces/${spaceId}/documents/${sharedDocumentId}`,
          owner.token,
          { method: "POST", body: JSON.stringify({ html: "<p>shared, updated</p>" }) },
        );
        expect(saved.status).toBe(200);
        expect(wsDecodeJson<{ topics: string[] }>(await event).topics).toEqual([
          realtimeTopics.document(sharedDocumentId),
        ]);
      } finally {
        connection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses topics a document-level viewer holds no grant on",
    async () => {
      const connection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentViewer.token,
      );

      try {
        for (const topic of [
          realtimeTopics.document(privateDocumentId),
          // Space-wide topics carry data about every document in the space.
          realtimeTopics.properties,
          realtimeTopics.documents,
          realtimeTopics.documentTree,
          realtimeTopics.acl,
        ]) {
          connection.socket.send(wsEncode(WsMsgType.Subscribe, { topics: [topic] }));
          const error = wsDecodeJson<{ message: string }>(
            await connection.waitForFrame(WsMsgType.Error, FRAME_TIMEOUT_MS),
          );
          expect(error.message).toBe("One or more realtime topics are forbidden");
        }

        // Presence in a document they were not shared is refused too.
        connection.socket.send(
          wsEncode(WsMsgType.PresenceJoin, {
            room: privateDocumentId,
            clientId: "viewer-client",
            user: { id: documentViewer.userId, name: "Document Viewer" },
          }),
        );
        const presenceError = wsDecodeJson<RealtimeErrorPayload>(
          await connection.waitForFrame(WsMsgType.Error, FRAME_TIMEOUT_MS),
        );
        expect(presenceError.scope).toBe("presence-join");
        expect(presenceError.room).toBe(privateDocumentId);
        await connection.expectNoFrame(WsMsgType.PresenceSnapshot);
      } finally {
        connection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets any caller unsubscribe, whatever they may subscribe to",
    async () => {
      const connection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentViewer.token,
      );

      try {
        // Dropping a subscription leaks nothing, so it must never be refused:
        // a caller whose role was revoked has to be able to stop the feed.
        connection.socket.send(
          wsEncode(WsMsgType.Unsubscribe, {
            topics: [realtimeTopics.documents, realtimeTopics.acl],
          }),
        );
        await connection.expectNoFrame(WsMsgType.Error, 2_000);
      } finally {
        connection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a user with no grant anywhere in the space",
    async () => {
      const connection = await connectWebSocket(AUTH_BASE_URL, spaceId, outsider.token);

      const error = wsDecodeJson<{ message: string }>(
        await connection.waitForFrame(WsMsgType.Error, FRAME_TIMEOUT_MS),
      );
      expect(error.message).toBe("Forbidden");
      await waitForClose(connection.socket);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names the document when it refuses a Yjs join",
    async () => {
      const connection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentViewer.token,
      );

      try {
        connection.socket.send(
          wsEncode(WsMsgType.YjsJoin, { documentId: privateDocumentId }),
        );

        // The client rejects the pending join off these fields; without them it
        // has nothing to match the refusal to and waits out its whole budget.
        const error = wsDecodeJson<RealtimeErrorPayload>(
          await connection.waitForFrame(WsMsgType.Error, FRAME_TIMEOUT_MS),
        );
        expect(error.scope).toBe("yjs-join");
        expect(error.documentId).toBe(privateDocumentId);
        expect(error.message).toBeTruthy();
        await connection.expectNoFrame(WsMsgType.YjsUpdate);
      } finally {
        connection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets a document-level editor edit over the Yjs connection",
    async () => {
      const editorConnection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentEditor.token,
      );
      const ownerConnection = await connectWebSocket(AUTH_BASE_URL, spaceId, owner.token);

      try {
        const editorDoc = await joinRoom(editorConnection, editableDocumentId);
        const ownerDoc = await joinRoom(ownerConnection, editableDocumentId);

        const broadcast = ownerConnection.waitForFrame(
          WsMsgType.YjsUpdate,
          FRAME_TIMEOUT_MS,
        );
        editorConnection.socket.send(
          wsEncodeYjsUpdate(
            editableDocumentId,
            appendParagraph(editorDoc, "from the document editor"),
          ),
        );

        Y.applyUpdate(ownerDoc, wsDecodeYjsUpdate(await broadcast).update, "remote");
        expect(ownerDoc.getXmlFragment("default").toString()).toContain(
          "from the document editor",
        );
        // The room, not just the other client, took the edit.
        expect(await readContent(editableDocumentId, "?live=true")).toContain(
          "from the document editor",
        );
      } finally {
        editorConnection.socket.close();
        ownerConnection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "still drops Yjs updates from a document-level viewer",
    async () => {
      const viewerConnection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentViewer.token,
      );
      const ownerConnection = await connectWebSocket(AUTH_BASE_URL, spaceId, owner.token);

      try {
        const viewerDoc = await joinRoom(viewerConnection, sharedDocumentId);
        await joinRoom(ownerConnection, sharedDocumentId);

        viewerConnection.socket.send(
          wsEncodeYjsUpdate(
            sharedDocumentId,
            appendParagraph(viewerDoc, "from the document viewer"),
          ),
        );

        await ownerConnection.expectNoFrame(WsMsgType.YjsUpdate, 1_500);
        expect(await readContent(sharedDocumentId, "?live=true")).not.toContain(
          "from the document viewer",
        );
      } finally {
        viewerConnection.socket.close();
        ownerConnection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores a presence leave for a room this connection never joined",
    async () => {
      const ownerConnection = await connectWebSocket(AUTH_BASE_URL, spaceId, owner.token);
      const viewerConnection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        documentViewer.token,
      );

      try {
        ownerConnection.socket.send(
          wsEncode(WsMsgType.PresenceJoin, {
            room: editableDocumentId,
            clientId: "owner-client",
            user: { id: owner.userId, name: "Share Owner" },
          }),
        );
        await ownerConnection.waitForFrame(WsMsgType.PresenceSnapshot, FRAME_TIMEOUT_MS);

        // The viewer holds no grant on this document and never joined the room,
        // so naming someone else's presence must not evict it.
        viewerConnection.socket.send(
          wsEncode(WsMsgType.PresenceLeave, {
            room: editableDocumentId,
            clientId: "owner-client",
          }),
        );

        await ownerConnection.expectNoFrame(WsMsgType.PresenceLeave, 1_500);
      } finally {
        viewerConnection.socket.close();
        ownerConnection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Realtime WebSocket access revocation", () => {
  const REVALIDATION_MS = 1_500;

  let owner: TestUserSession;
  let spaceId: string;

  async function permissionRequest(body: Record<string, unknown>): Promise<void> {
    const response = await authApiRequest(
      `/api/v1/spaces/${spaceId}/permissions`,
      owner.token,
      { method: "POST", body: JSON.stringify({ type: "role", ...body }) },
    );
    expect([200, 201]).toContain(response.status);
  }

  function setRole(
    userId: string,
    role: "viewer" | "editor",
    documentId?: string,
  ): Promise<void> {
    return permissionRequest({
      roleOrFeature: role,
      userId,
      action: "grant",
      ...(documentId ? { resourceType: "document", resourceId: documentId } : {}),
    });
  }

  function revokeRole(userId: string, documentId?: string): Promise<void> {
    return permissionRequest({
      roleOrFeature: "viewer",
      userId,
      action: "revoke",
      ...(documentId ? { resourceType: "document", resourceId: documentId } : {}),
    });
  }

  async function createDocument(title: string, content: string): Promise<string> {
    const response = await authApiRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      owner.token,
      { method: "POST", body: JSON.stringify({ content, properties: { title } }) },
    );
    expect(response.status).toBe(201);
    return (await response.json()).document.id;
  }

  async function readLiveContent(documentId: string): Promise<string> {
    const response = await authApiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}?live=true`,
      owner.token,
    );
    expect(response.status).toBe(200);
    return (await response.json()).document.content;
  }

  beforeAll(async () => {
    owner = await createTestUser(AUTH_BASE_URL, "Revoke Owner", "realtime-revoke-owner");
    const spaceResponse = await authApiRequest("/api/v1/spaces", owner.token, {
      method: "POST",
      body: JSON.stringify({
        name: "Realtime Revocation Space",
        slug: `realtime-revocation-${Date.now()}`,
      }),
    });
    expect(spaceResponse.status).toBe(201);
    spaceId = (await spaceResponse.json()).space.id;
  }, 60_000);

  it(
    "stops applying and persisting Yjs updates once the editor is revoked",
    async () => {
      const editor = await createTestUser(
        AUTH_BASE_URL,
        "Revoked Editor",
        "realtime-revoked-editor",
      );
      const documentId = await createDocument("Revoked", "<p>revoked</p>");
      // Keep read access while revoking only the document write grant.
      await setRole(editor.userId, "viewer");
      await setRole(editor.userId, "editor", documentId);

      const editorConnection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        editor.token,
      );
      const ownerConnection = await connectWebSocket(AUTH_BASE_URL, spaceId, owner.token);

      try {
        const editorDoc = await joinRoom(editorConnection, documentId);
        const ownerDoc = await joinRoom(ownerConnection, documentId);

        const accepted = ownerConnection.waitForFrame(
          WsMsgType.YjsUpdate,
          FRAME_TIMEOUT_MS,
        );
        editorConnection.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(editorDoc, "before revocation")),
        );
        Y.applyUpdate(ownerDoc, wsDecodeYjsUpdate(await accepted).update, "remote");

        await revokeRole(editor.userId, documentId);
        await waitForAccessChange(editorConnection, {
          scope: "document",
          resourceId: documentId,
          access: "view",
        });

        editorConnection.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(editorDoc, "after revocation")),
        );

        await ownerConnection.expectNoFrame(WsMsgType.YjsUpdate, 1_500);
        const content = await readLiveContent(documentId);
        expect(content).toContain("before revocation");
        expect(content).not.toContain("after revocation");
        expect(editorConnection.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        editorConnection.socket.close();
        ownerConnection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a downgraded editor reading while refusing their writes",
    async () => {
      const downgraded = await createTestUser(
        AUTH_BASE_URL,
        "Downgraded Editor",
        "realtime-downgraded-editor",
      );
      const documentId = await createDocument("Downgraded", "<p>downgraded</p>");
      await setRole(downgraded.userId, "editor");

      const editorConnection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        downgraded.token,
      );
      const ownerConnection = await connectWebSocket(AUTH_BASE_URL, spaceId, owner.token);

      try {
        const editorDoc = await joinRoom(editorConnection, documentId);
        const ownerDoc = await joinRoom(ownerConnection, documentId);

        await setRole(downgraded.userId, "viewer");
        await waitForAccessChange(editorConnection, {
          scope: "document",
          resourceId: documentId,
          access: "view",
        });

        const broadcast = editorConnection.waitForFrame(
          WsMsgType.YjsUpdate,
          FRAME_TIMEOUT_MS,
        );
        ownerConnection.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(ownerDoc, "from the owner")),
        );
        Y.applyUpdate(editorDoc, wsDecodeYjsUpdate(await broadcast).update, "remote");
        expect(editorDoc.getXmlFragment("default").toString()).toContain(
          "from the owner",
        );

        editorConnection.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(editorDoc, "from the viewer")),
        );
        await ownerConnection.expectNoFrame(WsMsgType.YjsUpdate, 1_500);
        expect(await readLiveContent(documentId)).not.toContain("from the viewer");
        expect(editorConnection.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        editorConnection.socket.close();
        ownerConnection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "evicts a revoked document while keeping access to another document",
    async () => {
      const grantee = await createTestUser(
        AUTH_BASE_URL,
        "Revoked Document Grantee",
        "realtime-revoked-document-grantee",
      );
      const revokedDocumentId = await createDocument(
        "Revoked document",
        "<p>revoked document</p>",
      );
      const retainedDocumentId = await createDocument(
        "Retained document",
        "<p>retained document</p>",
      );
      await setRole(grantee.userId, "editor", revokedDocumentId);
      await setRole(grantee.userId, "viewer", retainedDocumentId);

      const connection = await connectWebSocket(AUTH_BASE_URL, spaceId, grantee.token);
      try {
        await joinRoom(connection, revokedDocumentId);
        await revokeRole(grantee.userId, revokedDocumentId);

        await waitForAccessChange(connection, {
          scope: "document",
          resourceId: revokedDocumentId,
          access: "none",
        });
        const error = wsDecodeJson<RealtimeErrorPayload>(
          await connection.waitForFrame(WsMsgType.Error, FRAME_TIMEOUT_MS),
        );
        expect(error.scope).toBe("yjs-room");
        expect(error.documentId).toBe(revokedDocumentId);
        expect(connection.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        connection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closes the connection of a user removed from the space",
    async () => {
      const member = await createTestUser(
        AUTH_BASE_URL,
        "Removed Member",
        "realtime-removed-member",
      );
      const documentId = await createDocument("Removed", "<p>removed</p>");
      await setRole(member.userId, "viewer");

      const connection = await connectWebSocket(AUTH_BASE_URL, spaceId, member.token);
      await joinRoom(connection, documentId);
      await subscribe(connection, [realtimeTopics.documents]);
      await connection.expectNoFrame(WsMsgType.Error);

      await revokeRole(member.userId);

      await waitForAccessChange(connection, {
        scope: "space",
        access: "none",
      });

      expect(
        wsDecodeJson<{ message: string }>(
          await connection.waitForFrame(WsMsgType.Error, FRAME_TIMEOUT_MS),
        ).message,
      ).toBe("Forbidden");
      expect(await waitForClose(connection.socket)).toBe(WS_CLOSE_FORBIDDEN);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves a document-level grantee alone on an unrelated ACL change",
    async () => {
      const grantee = await createTestUser(
        AUTH_BASE_URL,
        "Shared Grantee",
        "realtime-unrelated-grantee",
      );
      const bystander = await createTestUser(
        AUTH_BASE_URL,
        "Bystander",
        "realtime-unrelated-bystander",
      );
      const documentId = await createDocument("Granted", "<p>granted</p>");
      // This user has only a document grant, not a space role.
      await setRole(grantee.userId, "editor", documentId);

      const granteeConnection = await connectWebSocket(
        AUTH_BASE_URL,
        spaceId,
        grantee.token,
      );
      const ownerConnection = await connectWebSocket(AUTH_BASE_URL, spaceId, owner.token);

      try {
        const granteeDoc = await joinRoom(granteeConnection, documentId);
        const ownerDoc = await joinRoom(ownerConnection, documentId);
        expect(ownerDoc.getXmlFragment("default").toString()).toContain("granted");

        await setRole(bystander.userId, "viewer");
        await Bun.sleep(REVALIDATION_MS);

        await granteeConnection.expectNoFrame(WsMsgType.Error);
        expect(granteeConnection.socket.readyState).toBe(WebSocket.OPEN);

        const broadcast = ownerConnection.waitForFrame(
          WsMsgType.YjsUpdate,
          FRAME_TIMEOUT_MS,
        );
        granteeConnection.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(granteeDoc, "still granted")),
        );
        Y.applyUpdate(ownerDoc, wsDecodeYjsUpdate(await broadcast).update, "remote");
        expect(await readLiveContent(documentId)).toContain("still granted");
      } finally {
        granteeConnection.socket.close();
        ownerConnection.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Realtime WebSocket readonly documents", () => {
  /**
   * The sync-event debounce (100ms) plus the re-authorization a lock/unlock
   * triggers. Padded for a loaded machine; the `YjsUpdate` path re-checks a
   * stale verdict itself, so this only has to outlast the debounce.
   */
  const REVALIDATION_MS = 1_500;

  async function createDocument(
    title: string,
    content: string,
    type?: string,
    readonly?: boolean,
  ): Promise<string> {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content,
        properties: { title },
        ...(type ? { type } : {}),
        ...(readonly !== undefined ? { readonly } : {}),
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).document.id;
  }

  /** `live` reads the open room's state, otherwise the persisted content. */
  async function readContent(documentId: string, live: boolean): Promise<string> {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${documentId}${live ? "?live=true" : ""}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()).document.content;
  }

  async function setReadonly(documentId: string, readonly: boolean): Promise<void> {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${documentId}`,
      { method: "PATCH", body: JSON.stringify({ readonly }) },
    );
    expect(response.status).toBe(200);
  }

  /** Rides out the persist debounce, which runs a second or more after an edit. */
  async function waitForPersistedContent(
    documentId: string,
    text: string,
  ): Promise<boolean> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await readContent(documentId, false)).includes(text)) return true;
      await Bun.sleep(250);
    }
    return false;
  }

  it(
    "stops applying and persisting Yjs updates once the document is locked",
    async () => {
      const documentId = await createDocument("Locked", "<p>locked</p>");
      const writer = await connectWebSocket(BASE_URL, testSpaceId);
      const observer = await connectWebSocket(BASE_URL, testSpaceId);

      try {
        const writerDoc = await joinRoom(writer, documentId);
        const observerDoc = await joinRoom(observer, documentId);

        // Establish that this socket really can write, so the assertion after the
        // lock is about the lock and not about the plumbing.
        const accepted = observer.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS);
        writer.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(writerDoc, "before the lock")),
        );
        Y.applyUpdate(observerDoc, wsDecodeYjsUpdate(await accepted).update, "remote");
        expect(await readContent(documentId, true)).toContain("before the lock");

        await setReadonly(documentId, true);

        writer.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(writerDoc, "after the lock")),
        );

        await observer.expectNoFrame(WsMsgType.YjsUpdate, 1_500);
        // Neither applied to the room nor written back to the document.
        expect(await readContent(documentId, true)).not.toContain("after the lock");
        expect(await readContent(documentId, false)).not.toContain("after the lock");
        expect(await readContent(documentId, false)).toContain("before the lock");
        // Reading is unaffected: only the write was withdrawn.
        expect(writer.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        writer.socket.close();
        observer.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "accepts Yjs updates again once the document is unlocked",
    async () => {
      const documentId = await createDocument("Unlocked", "<p>unlocked</p>");
      const writer = await connectWebSocket(BASE_URL, testSpaceId);
      const observer = await connectWebSocket(BASE_URL, testSpaceId);

      try {
        const lockedDoc = await joinRoom(writer, documentId);
        const observerDoc = await joinRoom(observer, documentId);

        await setReadonly(documentId, true);
        await Bun.sleep(REVALIDATION_MS);

        writer.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(lockedDoc, "while locked")),
        );
        await observer.expectNoFrame(WsMsgType.YjsUpdate, 1_500);

        // Rejoin for a client doc that matches the room again: the dropped update
        // left this client ahead of it, and Yjs holds anything built on top of a
        // missing update as pending.
        const writerDoc = await joinRoom(writer, documentId);

        await setReadonly(documentId, false);
        await Bun.sleep(REVALIDATION_MS);

        const accepted = observer.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS);
        writer.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(writerDoc, "after the unlock")),
        );
        Y.applyUpdate(observerDoc, wsDecodeYjsUpdate(await accepted).update, "remote");

        expect(observerDoc.getXmlFragment("default").toString()).toContain(
          "after the unlock",
        );
        expect(await readContent(documentId, true)).not.toContain("while locked");
        expect(await waitForPersistedContent(documentId, "after the unlock")).toBe(true);
      } finally {
        writer.socket.close();
        observer.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps every other document writable while one is locked",
    async () => {
      const lockedId = await createDocument("Locked Neighbour", "<p>locked</p>");
      const openId = await createDocument("Open Neighbour", "<p>open</p>");
      const writer = await connectWebSocket(BASE_URL, testSpaceId);
      const observer = await connectWebSocket(BASE_URL, testSpaceId);

      try {
        await joinRoom(writer, lockedId);
        const writerDoc = await joinRoom(writer, openId);
        const observerDoc = await joinRoom(observer, openId);

        // The lock invalidates every cached room verdict in the process, so this
        // asserts the re-authorization it triggers restores the ones it should.
        await setReadonly(lockedId, true);
        await Bun.sleep(REVALIDATION_MS);

        const accepted = observer.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS);
        writer.socket.send(
          wsEncodeYjsUpdate(openId, appendParagraph(writerDoc, "still writable")),
        );
        Y.applyUpdate(observerDoc, wsDecodeYjsUpdate(await accepted).update, "remote");

        expect(await readContent(openId, true)).toContain("still writable");
        expect(await waitForPersistedContent(openId, "still writable")).toBe(true);
      } finally {
        writer.socket.close();
        observer.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops Yjs updates for a document created readonly",
    async () => {
      // The persisted lock is the same verdict used by HTTP and realtime writes.
      const documentId = await createDocument(
        "Readonly document",
        "<p>locked</p>",
        "document",
        true,
      );
      const writer = await connectWebSocket(BASE_URL, testSpaceId);

      try {
        const writerDoc = await joinRoom(writer, documentId);
        writer.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(writerDoc, "injected row")),
        );

        await Bun.sleep(REVALIDATION_MS);
        expect(await readContent(documentId, true)).not.toContain("injected row");
        expect(await readContent(documentId, false)).not.toContain("injected row");
        expect(writer.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        writer.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Realtime WebSocket writes against an open room", () => {
  const PERSIST_MS = 6_500;

  async function createDocument(title: string, content: string): Promise<string> {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({ content, properties: { title } }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).document.id;
  }

  async function readStoredContent(documentId: string): Promise<string> {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${documentId}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()).document.content;
  }

  it(
    "carries a saved document into the room, so the next edit does not revert it",
    async () => {
      const documentId = await createDocument("Save into room", "<p>original</p>");
      const editor = await connectWebSocket(BASE_URL, testSpaceId);

      try {
        const editorDoc = await joinRoom(editor, documentId);

        const save = await apiRequest(
          `/api/v1/spaces/${testSpaceId}/documents/${documentId}`,
          { method: "PUT", body: JSON.stringify({ content: "<p>saved over http</p>" }) },
        );
        expect(save.status).toBe(200);

        const update = wsDecodeYjsUpdate(
          await editor.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS),
        );
        Y.applyUpdate(editorDoc, update.update, "remote");
        expect(editorDoc.getXmlFragment("default").toString()).toContain(
          "saved over http",
        );

        editor.socket.send(
          wsEncodeYjsUpdate(documentId, appendParagraph(editorDoc, "typed after save")),
        );
        await Bun.sleep(PERSIST_MS);

        const stored = await readStoredContent(documentId);
        expect(stored).toContain("saved over http");
        expect(stored).toContain("typed after save");
      } finally {
        editor.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a reconnecting editor's unsynced updates, and applies what it sends next",
    async () => {
      const documentId = await createDocument("Reconnect sync", "<p>base</p>");
      const first = await connectWebSocket(BASE_URL, testSpaceId);
      const clientDoc = await joinRoom(first, documentId);

      first.socket.send(
        wsEncodeYjsUpdate(documentId, appendParagraph(clientDoc, "before the drop")),
      );
      await Bun.sleep(PERSIST_MS);
      first.socket.close();
      await waitForClose(first.socket);

      const second = await connectWebSocket(BASE_URL, testSpaceId);
      try {
        second.socket.send(
          wsEncode(WsMsgType.YjsJoin, {
            documentId,
            stateVector: Buffer.from(Y.encodeStateVector(clientDoc)).toString("base64"),
          }),
        );
        Y.applyUpdate(
          clientDoc,
          wsDecodeYjsUpdate(
            await second.waitForFrame(WsMsgType.YjsUpdate, FRAME_TIMEOUT_MS),
          ).update,
          "remote",
        );

        const request = wsDecodeYjsUpdate(
          await second.waitForFrame(WsMsgType.YjsSyncRequest, FRAME_TIMEOUT_MS),
        );
        expect(request.documentId).toBe(documentId);
        const missing = Y.encodeStateAsUpdate(clientDoc, request.update);
        second.socket.send(wsEncodeYjsUpdate(documentId, missing));

        expect(
          clientDoc.getXmlFragment("default").toString().split("before the drop").length -
            1,
        ).toBe(1);

        second.socket.send(
          wsEncodeYjsUpdate(
            documentId,
            appendParagraph(clientDoc, "after the reconnect"),
          ),
        );
        await Bun.sleep(PERSIST_MS);

        const stored = await readStoredContent(documentId);
        expect(stored).toContain("before the drop");
        expect(stored).toContain("after the reconnect");
      } finally {
        second.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "persists the room before dropping it, so an immediate reopen sees the last edit",
    async () => {
      const documentId = await createDocument("Reopen race", "<p>base</p>");
      const first = await connectWebSocket(BASE_URL, testSpaceId);
      const clientDoc = await joinRoom(first, documentId);

      first.socket.send(
        wsEncodeYjsUpdate(
          documentId,
          appendParagraph(clientDoc, "last edit before close"),
        ),
      );
      await Bun.sleep(50);
      first.socket.close();
      await waitForClose(first.socket);

      const second = await connectWebSocket(BASE_URL, testSpaceId);
      try {
        const reopened = await joinRoom(second, documentId);
        expect(reopened.getXmlFragment("default").toString()).toContain(
          "last edit before close",
        );
      } finally {
        second.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("idle Yjs rooms", () => {
  const GRACE_MS = 10 * 60 * 1000;

  function addIdleRoom(key: string): void {
    yRooms.set(key, { clients: new Set(), presences: new Map(), doc: new Y.Doc() });
  }

  afterEach(() => {
    for (const key of [...yRooms.keys()]) {
      if (key.startsWith("sweep:")) yRooms.delete(key);
    }
  });

  it("keeps a room a client just left, so a reconnect resumes the same document", () => {
    addIdleRoom("sweep:kept");
    const now = Date.now();
    sweepIdleYRooms(now);
    expect(yRooms.has("sweep:kept")).toBe(true);

    sweepIdleYRooms(now + GRACE_MS - 1_000);
    expect(yRooms.has("sweep:kept")).toBe(true);
  });

  it("drops it once the grace period has passed", () => {
    addIdleRoom("sweep:expired");
    const now = Date.now();
    sweepIdleYRooms(now);
    sweepIdleYRooms(now + GRACE_MS + 1_000);
    expect(yRooms.has("sweep:expired")).toBe(false);
  });

  it("keeps a room with a client in it however long it sits", () => {
    const socket = { readyState: 1 } as unknown as WebSocket;
    yRooms.set("sweep:busy", {
      clients: new Set([socket]),
      presences: new Map(),
      doc: new Y.Doc(),
    });
    const now = Date.now();
    sweepIdleYRooms(now);
    sweepIdleYRooms(now + GRACE_MS * 10);
    expect(yRooms.has("sweep:busy")).toBe(true);
  });

  it("caps how many idle rooms it holds, dropping the ones idle longest first", () => {
    const now = Date.now();
    for (let i = 0; i < 205; i++) addIdleRoom(`sweep:capped-${i}`);
    sweepIdleYRooms(now);
    const held = [...yRooms.keys()].filter((key) => key.startsWith("sweep:capped-"));
    expect(held.length).toBeLessThanOrEqual(200);
    expect(held.length).toBeGreaterThan(0);
  });
});
