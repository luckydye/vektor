import type { IncomingMessage, Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import {
  isAccessDenied,
  verifyDocumentRole,
  verifyExtensionAccess,
  verifyResourceAccess,
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
import { subscribeToSyncEvents } from "./events.ts";
import { PresenceConnection, type PresenceRoomAccess } from "./presence.ts";
import {
  extensionIdFromPresenceRoom,
  realtimeTopics,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHORIZED,
  WsMsgType,
  wsDecode,
  wsEncode,
} from "./protocol.ts";
import { TopicSubscriptions } from "./subscriptions.ts";
import { noteAclChange, YjsConnection } from "./yjsConnection.ts";

/**
 * One family of frames plus the per-connection state it owns. Handlers are
 * tried in order and the first to claim a frame ends the dispatch, so an
 * unclaimed frame is an unsupported one.
 */
interface FrameHandler {
  handle(type: WsMsgType, payload: Uint8Array): Promise<boolean>;
  /** Re-runs the authorization this handler's state is standing on. */
  revalidate(): Promise<void>;
  close(): void;
}

/**
 * Re-authorization hooks for the live connections, so the periodic sweep can
 * reach them. Connections register on open and deregister on close.
 */
const connectionRevalidators = new Set<() => void>();

/**
 * Whether `userId` may join a presence room. Extension rooms are gated on the
 * extension, everything else is a document id — which is why a malformed
 * extension room must not fall through to document ACLs.
 */
async function authorizePresenceRoom(
  spaceId: string,
  userId: string,
  room: string,
): Promise<PresenceRoomAccess> {
  const extensionId = extensionIdFromPresenceRoom(room);
  if (extensionId !== null) {
    if (!extensionId) return "denied";
    try {
      const store = await openSpaceStore(spaceId);
      if (!(await getExtension(store, extensionId))) return "denied";
      if (isNoAuthMode()) return "allowed";
      await verifyExtensionAccess(spaceId, extensionId, userId);
      return "allowed";
    } catch (error) {
      return isAccessDenied(error) ? "denied" : "unknown";
    }
  }

  try {
    await verifyDocumentRole(spaceId, room, userId, Permission.VIEWER);
    return "allowed";
  } catch (error) {
    return isAccessDenied(error) ? "denied" : "unknown";
  }
}

/** Resolves the connecting user, or null once the socket has been refused. */
async function authenticateConnection(
  websocket: WebSocket,
  request: IncomingMessage,
  spaceId: string,
): Promise<string | null> {
  if (isNoAuthMode()) return LOCAL_USER_ID;

  const session = await auth.api.getSession({
    headers: request.headers as unknown as Headers,
  });

  if (!session?.user?.id) {
    websocket.send(wsEncode(WsMsgType.Error, { message: "Unauthorized" }));
    websocket.close(WS_CLOSE_UNAUTHORIZED, "Unauthorized");
    return null;
  }

  try {
    // Reachability only — a space role OR any document/tree/category grant, so
    // a document-level grantee is admitted as it is over HTTP. Authorizes
    // nothing: every topic, Yjs room and presence room is checked on its own.
    await verifyResourceAccess(spaceId, session.user.id);
  } catch (error) {
    // Refused either way, but only a verdict is worth telling the client not to
    // retry: an ACL that could not be read is a reason to come back later.
    websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
    if (isAccessDenied(error)) {
      websocket.close(WS_CLOSE_FORBIDDEN, "Forbidden");
    } else {
      appLogger.warn("Could not authorize a realtime connection", { error, spaceId });
      websocket.close();
    }
    return null;
  }

  return session.user.id;
}

function toBuffer(rawMessage: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(rawMessage)) return Buffer.concat(rawMessage);
  return Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage);
}

async function handleRealtimeWebSocket(
  websocket: WebSocket,
  request: IncomingMessage,
  spaceId: string,
): Promise<void> {
  const userId = await authenticateConnection(websocket, request, spaceId);
  if (userId === null) return;

  // Each claims a disjoint set of frame types, so this order is only the order
  // they are torn down in: stop the event fan-out before the rooms it may push
  // into go away, and let the Yjs half release a room before presence decides
  // whether it may still leave the socket in it.
  const yjs = new YjsConnection(spaceId, userId, websocket);
  const handlers: FrameHandler[] = [
    new TopicSubscriptions(spaceId, userId, websocket),
    yjs,
    new PresenceConnection(spaceId, websocket, {
      authorizeRoom: (room) => authorizePresenceRoom(spaceId, userId, room),
      holdsYjsRoom: (room) => yjs.holdsRoom(room),
    }),
  ];

  /** Refuse the connection for good, releasing what it holds right away. */
  const closeForbidden = (): void => {
    websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
    // Ahead of the close handshake, which the peer has up to 30s to answer —
    // long enough for a revoked user's cursor to sit in a room they have lost.
    for (const handler of handlers) handler.close();
    websocket.close(WS_CLOSE_FORBIDDEN, "Forbidden");
    appLogger.info("Closed realtime connection whose space access was revoked", {
      spaceId,
    });
  };

  /**
   * Re-runs every authorization this connection is standing on. Losing
   * everything (removal from the space, or the last document grant of a
   * document-level grantee) closes the connection; losing one resource only
   * drops the room, topic or presence entry it covered.
   */
  const revalidateConnection = async (): Promise<void> => {
    if (websocket.readyState !== 1) return;

    try {
      // Exactly the gate the handshake applied. It must stay
      // `verifyResourceAccess`: a space-role check here would disconnect every
      // document-level grantee on the next unrelated ACL change in the space.
      await verifyResourceAccess(spaceId, userId);
    } catch (error) {
      // Only a verdict disconnects. The sweep runs this for every live
      // connection, so reading an unreachable ACL as a revocation would empty
      // the server on a single failed query.
      if (!isAccessDenied(error)) {
        appLogger.warn("Could not re-authorize a realtime connection; keeping it", {
          error,
          spaceId,
        });
        return;
      }
      closeForbidden();
      return;
    }

    // Independently, so one half failing does not leave the others standing on
    // an authorization nobody re-ran.
    for (const handler of handlers) {
      try {
        await handler.revalidate();
      } catch (error) {
        appLogger.warn("Failed to re-authorize part of a realtime connection", {
          error,
          spaceId,
        });
      }
    }
  };

  // Serialized: ACL events arrive in bursts, and two overlapping passes would
  // race each other's eviction of the same room.
  let pendingRevalidation: Promise<void> = Promise.resolve();
  const scheduleRevalidation = (): void => {
    pendingRevalidation = pendingRevalidation
      .then(revalidateConnection)
      .catch((error) => {
        appLogger.warn("Failed to re-authorize realtime connection", { error, spaceId });
      });
  };
  connectionRevalidators.add(scheduleRevalidation);

  // The ACL store announces every grant/revoke on this topic, so it is the
  // signal that this connection's authorization may no longer hold. Noted even
  // when the client is not subscribed to the topic (it needs a space role to
  // be): the server-side re-authorization must not depend on what the client
  // asked to hear about.
  const offAclEvents = subscribeToSyncEvents((event) => {
    if (event.spaceId !== spaceId) return;
    if (!event.events.some(({ topic }) => topic === realtimeTopics.acl)) return;

    noteAclChange();
    scheduleRevalidation();
  });

  websocket.on("message", async (rawMessage: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const { type, payload } = wsDecode(toBuffer(rawMessage));

      if (type === WsMsgType.Ping) {
        websocket.send(wsEncode(WsMsgType.Pong, {}));
        return;
      }

      for (const handler of handlers) {
        if (await handler.handle(type, payload)) return;
      }

      throw new Error("Unsupported message type");
    } catch (error) {
      appLogger.warn("Failed to handle realtime message", { error, spaceId });
      websocket.send(wsEncode(WsMsgType.Error, { message: "Invalid message" }));
    }
  });

  websocket.on("close", () => {
    offAclEvents();
    connectionRevalidators.delete(scheduleRevalidation);
    for (const handler of handlers) handler.close();
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

/**
 * Belt and braces around the event-driven re-authorization, for an ACL write
 * that publishes no sync event (the identity-provider group sync rewrites a
 * user's groups with no space and no audit row) or a listener that threw.
 *
 * It covers the read direction, which has no hot path to hang off — a passive
 * reader sends nothing, so only a sweep can evict it. Deliberately coarse (a
 * handful of indexed reads per connection per sweep) and matched to the 60s
 * identity-provider group refresh, the one ACL input that changes with no event
 * at all. The write direction is bounded more tightly by the per-room TTL in
 * `YjsConnection`.
 */
const ACL_REVALIDATE_INTERVAL_MS = 30_000;

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

  const authSweep = setInterval(() => {
    for (const revalidate of connectionRevalidators) revalidate();
  }, ACL_REVALIDATE_INTERVAL_MS);
  authSweep.unref?.();

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
      clearInterval(authSweep);
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
