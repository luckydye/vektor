import type { IncomingMessage, Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import {
  verifyDocumentRole,
  verifyExtensionAccess,
  verifyResourceAccess,
  verifySpaceRole,
} from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { auth } from "#auth";
import { openSpaceStore } from "#db/client/store.ts";
import { getExtension } from "#db/space/extensions.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";
import { appLogger } from "#observability/logger.ts";
import {
  decrementWebSocketConnections,
  incrementWebSocketConnections,
} from "#observability/metrics.ts";
import { tracedSync } from "#observability/trace.ts";
import { subscribeToSyncEvents } from "./events.ts";
import { PresenceConnection } from "./presence.ts";
import {
  extensionIdFromPresenceRoom,
  isDocumentRealtimeTopic,
  isWorkflowRunRealtimeTopic,
  realtimeTopics,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "./protocol.ts";
import {
  getRoom,
  loadYDoc,
  persistYRoomDraftBestEffort,
  scheduleYRoomDraftPersist,
  yRooms,
} from "./yjsRooms.ts";

/**
 * Topics whose events describe the space as a whole rather than one resource:
 * they carry document titles, property values, category names and ids from
 * anywhere in the space, so there is no per-resource check that could scope
 * them to a document-level grantee. They stay gated on a space-wide role.
 */
const realtimeSpaceTopics = new Set<string>([
  realtimeTopics.acl,
  realtimeTopics.categories,
  realtimeTopics.categoryDocuments,
  realtimeTopics.documentTree,
  realtimeTopics.documents,
  realtimeTopics.extensions,
  realtimeTopics.properties,
  realtimeTopics.workflowRuns,
]);

/**
 * Decide whether `userId` may subscribe to `topic`.
 *
 * Every topic is authorized against the resource it describes — the connection
 * itself grants nothing beyond a relationship to the space (see
 * {@link verifyResourceAccess}). `hasSpaceRole` resolves the caller's space-wide
 * viewer role for the space-scoped topics that need one; it is passed in so a
 * single subscribe frame naming several such topics costs one lookup.
 */
async function authorizeRealtimeTopic(
  spaceId: string,
  userId: string,
  topic: string,
  hasSpaceRole: () => Promise<boolean>,
): Promise<boolean> {
  if (realtimeSpaceTopics.has(topic)) {
    return await hasSpaceRole();
  }

  if (isDocumentRealtimeTopic(topic)) {
    try {
      await verifyDocumentRole(
        spaceId,
        topic.slice("document:".length),
        userId,
        Permission.VIEWER,
      );
    } catch {
      // Missing document or insufficient access: treat as a forbidden topic so
      // the caller reports it rather than tearing the whole message down.
      return false;
    }
    return true;
  }

  // Per-run topics are pure change signals; the run data itself is fetched via
  // the ACL-checked run endpoints. Which runs exist is still space-wide
  // information, so a space-wide role is required to listen for the signal.
  if (isWorkflowRunRealtimeTopic(topic)) {
    return await hasSpaceRole();
  }

  return false;
}

/**
 * A space-viewer verdict for one message, computed at most once. Fresh per
 * frame rather than cached on the connection, so a revoked role stops
 * authorizing new subscriptions.
 */
function spaceRoleResolver(spaceId: string, userId: string): () => Promise<boolean> {
  let verdict: Promise<boolean> | undefined;
  return () => {
    verdict ??= verifySpaceRole(spaceId, userId, Permission.VIEWER).then(
      () => true,
      () => false,
    );
    return verdict;
  };
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
      // Only a cheap "does this user have any business in this space" gate: a
      // space role OR any document/tree/category grant, mirroring
      // `authenticateSpaceAccess` so a document-level grantee is admitted here
      // exactly as it is over HTTP. It authorizes nothing on its own — every
      // topic, Yjs room and presence room is verified against its own resource
      // below.
      await verifyResourceAccess(spaceId, session.user.id);
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
  const presence = new PresenceConnection(spaceId, websocket, async (room) => {
    const extensionId = extensionIdFromPresenceRoom(room);
    if (extensionId !== null) {
      // A malformed extension room must not fall through to document ACLs.
      if (!extensionId) return false;
      if (!(await getExtension(await openSpaceStore(spaceId), extensionId))) return false;
      if (isNoAuthMode()) return true;
      try {
        await verifyExtensionAccess(spaceId, extensionId, userId);
        return true;
      } catch {
        return false;
      }
    }

    try {
      await verifyDocumentRole(spaceId, room, userId, Permission.VIEWER);
      return true;
    } catch {
      return false;
    }
  });
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
        scheduleYRoomDraftPersist(roomKey, userId);

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
          await verifyDocumentRole(spaceId, documentId, userId, Permission.EDITOR);
          canEdit = true;
        } catch {
          try {
            await verifyDocumentRole(spaceId, documentId, userId, Permission.VIEWER);
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

      if (type === WsMsgType.Ping) {
        websocket.send(wsEncode(WsMsgType.Pong, {}));
        return;
      }

      if (await presence.handle(type, payload)) {
        return;
      }

      if (type !== WsMsgType.Subscribe && type !== WsMsgType.Unsubscribe) {
        throw new Error("Unsupported message type");
      }

      const { topics } = wsDecodeJson<{ topics: string[] }>(payload);
      const hasSpaceRole = spaceRoleResolver(spaceId, userId);
      const authorizedTopics = new Set<string>();
      for (const topic of topics) {
        if (await authorizeRealtimeTopic(spaceId, userId, topic, hasSpaceRole)) {
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

/**
 * How long a connection may go without a frame before it is dropped, and how
 * often the sweep looks. Clients ping every 25s, so silence this long is three
 * missed rounds — a connection that died without a close frame, holding its
 * Yjs rooms and presence entries.
 */
const CONNECTION_IDLE_TIMEOUT_MS = 90_000;
const IDLE_SWEEP_INTERVAL_MS = 30_000;

/** Attaches the realtime collaboration endpoint to the HTTP server. */
export function attachRealtimeWebSocketServer(server: Server): RealtimeWebSocketServer {
  const websocketServer = new WebSocketServer({ noServer: true });
  const lastSeenAt = new WeakMap<WebSocket, number>();

  const idleSweep = setInterval(() => {
    const deadline = Date.now() - CONNECTION_IDLE_TIMEOUT_MS;
    for (const client of websocketServer.clients) {
      if ((lastSeenAt.get(client) ?? 0) > deadline) continue;
      client.terminate();
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();

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
      lastSeenAt.set(websocket, Date.now());
      websocket.on("message", () => lastSeenAt.set(websocket, Date.now()));
      void handleRealtimeWebSocket(websocket, request, match[1]);
    });
  });

  return {
    close(): void {
      clearInterval(idleSweep);
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
