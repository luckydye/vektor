import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  realtimeTopics,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsEncode,
} from "#utils/realtime.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7486;
const AUTH_PORT = 7487;
const BASE_URL = testBaseUrl(PORT);
const AUTH_BASE_URL = testBaseUrl(AUTH_PORT);
const apiRequest = createApiRequest(BASE_URL);

interface ReceivedFrame {
  type: WsMsgType;
  payload: Uint8Array;
}

interface SocketFrames {
  socket: WebSocket;
  expectNoFrame(type: WsMsgType, timeoutMs?: number): Promise<void>;
  waitForFrame(type: WsMsgType, timeoutMs?: number): Promise<Uint8Array>;
}

let serverProcess: TestServerProcess;
let authServerProcess: TestServerProcess;
let testSpaceId: string;
let testDocumentId: string;

function websocketUrl(baseUrl: string, spaceId: string): string {
  return `${baseUrl.replace("http", "ws")}/events/${spaceId}`;
}

function connectWebSocket(baseUrl: string, spaceId: string): Promise<SocketFrames> {
  const socket = new WebSocket(websocketUrl(baseUrl, spaceId));
  socket.binaryType = "arraybuffer";

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
      return Promise.resolve(frames.splice(existingIndex, 1)[0]!.payload);
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

async function waitForClose(socket: WebSocket, timeoutMs = 5_000): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket close")),
      timeoutMs,
    );
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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
    connection.socket.send(
      wsEncode(WsMsgType.Subscribe, { topics: [realtimeTopics.categories] }),
    );
    await Bun.sleep(50);

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
    await waitForClose(connection.socket);
  });
});
