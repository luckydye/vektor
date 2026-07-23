import type { IncomingMessage, Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { auth } from "#auth";
import { verifyDocumentRole, verifySpaceRole } from "#db/api.ts";
import { subscribeToSyncEvents } from "#db/ws.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";
import { appLogger } from "#observability/logger.ts";
import {
  decrementWebSocketConnections,
  incrementWebSocketConnections,
} from "#observability/metrics.ts";
import { tracedSync } from "#observability/trace.ts";
import {
  isDocumentRealtimeTopic,
  isWorkflowRunRealtimeTopic,
  realtimeTopics,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "#utils/realtime.ts";
import {
  getRoom,
  loadYDoc,
  persistYRoomDraftBestEffort,
  scheduleYRoomDraftPersist,
  yRooms,
} from "#utils/yjsRooms.ts";
import { PresenceConnection } from "./presence.ts";

const realtimeSpaceTopics = new Set<string>([
  realtimeTopics.acl,
  realtimeTopics.categories,
  realtimeTopics.categoryDocuments,
  realtimeTopics.documentTree,
  realtimeTopics.documents,
  realtimeTopics.properties,
  realtimeTopics.workflowRuns,
]);

async function authorizeRealtimeTopic(
  spaceId: string,
  userId: string,
  topic: string,
): Promise<boolean> {
  if (realtimeSpaceTopics.has(topic)) {
    return true;
  }

  if (isDocumentRealtimeTopic(topic)) {
    try {
      await verifyDocumentRole(
        spaceId,
        topic.slice("document:".length),
        userId,
        "viewer",
      );
    } catch {
      // Missing document or insufficient access: treat as a forbidden topic so
      // the caller reports it rather than tearing the whole message down.
      return false;
    }
    return true;
  }

  // Per-run topics are pure change signals; the run data itself is fetched via
  // the ACL-checked run endpoints. The connection is already space-viewer authed.
  if (isWorkflowRunRealtimeTopic(topic)) {
    return true;
  }

  return false;
}

async function handleRealtimeWebSocket(
  websocket: WebSocket,
  request: IncomingMessage,
  spaceId: string,
): Promise<void> {
  let userId: string;

  if (isNoAuthMode()) {
    userId = LOCAL_USER_ID;
  } else {
    const session = await auth.api.getSession({
      headers: request.headers as unknown as Headers,
    });

    if (!session?.user?.id) {
      websocket.send(wsEncode(WsMsgType.Error, { message: "Unauthorized" }));
      websocket.close();
      return;
    }

    try {
      await verifySpaceRole(spaceId, session.user.id, "viewer");
    } catch {
      websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      websocket.close();
      return;
    }

    userId = session.user.id;
  }

  const subscriptions = new Set<string>();
  const yjsRooms = new Set<string>();
  // Rooms this connection may mutate (editor role). Viewers can join to receive
  // state but may not send updates.
  const yjsEditableRooms = new Set<string>();
  const presence = new PresenceConnection(spaceId, userId, websocket);
  const off = subscribeToSyncEvents((event) => {
    if (event.spaceId !== spaceId) return;

    const matchedEvents = event.events.filter(({ topic }) => subscriptions.has(topic));
    if (matchedEvents.length === 0) return;

    websocket.send(
      wsEncode(WsMsgType.Event, {
        topics: matchedEvents.map(({ topic }) => topic),
        events: matchedEvents,
        timestamp: event.timestamp,
      }),
    );
  });

  websocket.on("message", async (rawMessage: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const messageBuffer = Array.isArray(rawMessage)
        ? Buffer.concat(rawMessage)
        : Buffer.isBuffer(rawMessage)
          ? rawMessage
          : Buffer.from(rawMessage);
      const { type, payload } = wsDecode(messageBuffer);

      if (type === WsMsgType.YjsUpdate) {
        const { documentId, update } = wsDecodeYjsUpdate(payload);
        const roomKey = `${spaceId}:${documentId}`;
        // Only editors may mutate the room. Viewers receive state on join but
        // their updates are dropped (a read-only client should never produce
        // them anyway).
        if (!yjsEditableRooms.has(roomKey)) return;
        const room = yRooms.get(roomKey);
        if (!room?.doc) return;

        tracedSync("yjs.applyUpdate", () =>
          Y.applyUpdate(room.doc as Y.Doc, update, websocket),
        );
        scheduleYRoomDraftPersist(roomKey);

        const frame = wsEncodeYjsUpdate(documentId, update);
        tracedSync("yjs.broadcast", () => {
          for (const client of room.clients) {
            if (client !== websocket && client.readyState === 1) {
              client.send(frame);
            }
          }
        });
        return;
      }

      if (type === WsMsgType.YjsJoin) {
        const { documentId } = wsDecodeJson<{ documentId: string }>(payload);
        // Editors get read+write; viewers may still join to receive state
        // (the room is the single source of truth for rendering). Anyone
        // without view access is rejected.
        let canEdit = false;
        try {
          await verifyDocumentRole(spaceId, documentId, userId, "editor");
          canEdit = true;
        } catch {
          try {
            await verifyDocumentRole(spaceId, documentId, userId, "viewer");
          } catch {
            websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
            return;
          }
        }

        const roomKey = `${spaceId}:${documentId}`;
        const room = getRoom(spaceId, documentId);
        if (!room.doc) {
          room.doc = await loadYDoc(spaceId, documentId);
        }

        room.clients.add(websocket);
        yjsRooms.add(roomKey);
        if (canEdit) yjsEditableRooms.add(roomKey);

        const stateUpdate = tracedSync("yjs.encodeState", () =>
          Y.encodeStateAsUpdate(room.doc as Y.Doc),
        );
        tracedSync("yjs.sendState", () =>
          websocket.send(wsEncodeYjsUpdate(documentId, stateUpdate)),
        );
        return;
      }

      if (await presence.handle(type, payload)) {
        return;
      }

      if (type !== WsMsgType.Subscribe && type !== WsMsgType.Unsubscribe) {
        throw new Error("Unsupported message type");
      }

      const { topics } = wsDecodeJson<{ topics: string[] }>(payload);
      const authorizedTopics = new Set<string>();
      for (const topic of topics) {
        if (await authorizeRealtimeTopic(spaceId, userId, topic)) {
          authorizedTopics.add(topic);
        }
      }

      if (authorizedTopics.size !== topics.length) {
        websocket.send(
          wsEncode(WsMsgType.Error, {
            message: "One or more realtime topics are forbidden",
          }),
        );
      }

      if (type === WsMsgType.Subscribe) {
        for (const topic of authorizedTopics) subscriptions.add(topic);
      } else {
        for (const topic of authorizedTopics) subscriptions.delete(topic);
      }
    } catch (error) {
      appLogger.warn("Failed to handle realtime message", { error, spaceId });
      websocket.send(wsEncode(WsMsgType.Error, { message: "Invalid message" }));
    }
  });

  websocket.on("close", () => {
    off();

    for (const roomKey of yjsRooms) {
      const room = yRooms.get(roomKey);
      if (!room) continue;
      persistYRoomDraftBestEffort(roomKey);
      room.clients.delete(websocket);
      if (room.clients.size === 0 && room.presences.size === 0) {
        yRooms.delete(roomKey);
      }
    }

    presence.close();

    appLogger.info("Realtime WebSocket connection closed", { spaceId });
  });
}

export interface RealtimeWebSocketServer {
  close(): void;
}

/** Attaches the realtime collaboration endpoint to the HTTP server. */
export function attachRealtimeWebSocketServer(server: Server): RealtimeWebSocketServer {
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/events\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      incrementWebSocketConnections();
      websocket.once("close", decrementWebSocketConnections);
      void handleRealtimeWebSocket(websocket, request, match[1]);
    });
  });

  return {
    close(): void {
      websocketServer.close();
      for (const client of websocketServer.clients) {
        try {
          client.close();
        } catch (error) {
          appLogger.warn("Failed to close WebSocket client", { error });
        }
      }
    },
  };
}
