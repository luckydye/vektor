import { subscribeToAuthorizationChanges } from "#acl/events.ts";
import { isAccessDenied, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { resolveRequestIdentity } from "#acl/session.ts";
import { isNoAuthMode } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { getExtension } from "#db/space/extensions.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { requestScope } from "#utils/requestScope.ts";
import { PresenceConnection, type PresenceRoomAccess } from "./presence.ts";
import {
  extensionIdFromPresenceRoom,
  type RealtimeErrorPayload,
  type RealtimeSocket,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHORIZED,
  WsMsgType,
  wsDecode,
  wsEncode,
  wsMsgTypeName,
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
  revalidate(): Promise<void>;
  close(): void;
}

/**
 * Whether `userId` may join a presence room. Extension rooms are gated on the
 * extension, everything else is a document id — which is why a malformed
 * extension room must not fall through to document ACLs.
 */
async function authorizePresenceRoom(
  platform: Platform,
  spaceId: string,
  userId: string,
  room: string,
): Promise<PresenceRoomAccess> {
  const extensionId = extensionIdFromPresenceRoom(room);
  if (extensionId !== null) {
    if (!extensionId) return "denied";
    try {
      const store = await openSpaceStore(platform, spaceId);
      if (!(await getExtension(store, extensionId))) return "denied";
      if (isNoAuthMode()) return "allowed";
      await verifyAccess(
        platform,
        spaceId,
        { type: ResourceType.EXTENSION, id: extensionId },
        userId,
        Permission.VIEWER,
      );
      return "allowed";
    } catch (error) {
      return isAccessDenied(error) ? "denied" : "unknown";
    }
  }

  try {
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.DOCUMENT, id: room },
      userId,
      Permission.VIEWER,
    );
    return "allowed";
  } catch (error) {
    return isAccessDenied(error) ? "denied" : "unknown";
  }
}

/** Resolves the connecting user, or null once the socket has been refused. */
async function authenticateConnection(
  platform: Platform,
  websocket: RealtimeSocket,
  headers: Headers,
  spaceId: string,
): Promise<string | null> {
  const { user } = await resolveRequestIdentity(platform, headers);

  if (!user) {
    websocket.send(wsEncode(WsMsgType.Error, { message: "Unauthorized" }));
    websocket.close(WS_CLOSE_UNAUTHORIZED, "Unauthorized");
    return null;
  }

  // No-auth's local user is owner on every space that exists, so the
  // reachability check below can only agree — and it must not refuse a space
  // this mode has yet to create.
  if (isNoAuthMode()) return user.id;

  try {
    // Reachability only — a space role OR any document/tree/category grant, so
    // a document-level grantee is admitted as it is over HTTP. Authorizes
    // nothing: every topic, Yjs room and presence room is checked on its own.
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId, anyGrantInSpace: true },
      user.id,
      Permission.VIEWER,
    );
  } catch (error) {
    websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
    if (isAccessDenied(error)) {
      websocket.close(WS_CLOSE_FORBIDDEN, "Forbidden");
    } else {
      appLogger.warn("Could not authorize a realtime connection", { error, spaceId });
      websocket.close();
    }
    return null;
  }

  return user.id;
}

/** What the transport feeds an accepted connection. */
export interface RealtimeConnection {
  message(frame: Uint8Array): Promise<void>;
  close(): void;
}

/**
 * Attach the realtime protocol to a socket for `spaceId`, or null once it was
 * refused. Frames that arrive while it authenticates are dropped.
 */
export async function acceptRealtimeConnection(
  platform: Platform,
  websocket: RealtimeSocket,
  headers: Headers,
  spaceId: string,
): Promise<RealtimeConnection | null> {
  const userId = await authenticateConnection(platform, websocket, headers, spaceId);
  if (userId === null) return null;

  // Teardown order matters because presence and Yjs share room membership.
  const yjs = new YjsConnection(platform, spaceId, userId, websocket);
  const handlers: FrameHandler[] = [
    new TopicSubscriptions(platform, spaceId, userId, websocket),
    yjs,
    new PresenceConnection(platform, spaceId, websocket, {
      authorizeRoom: (room) => authorizePresenceRoom(platform, spaceId, userId, room),
      holdsYjsRoom: (room) => yjs.holdsRoom(room),
    }),
  ];

  const closeForbidden = (): void => {
    websocket.send(wsEncode(WsMsgType.AccessChanged, { scope: "space", access: "none" }));
    websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
    for (const handler of handlers) handler.close();
    websocket.close(WS_CLOSE_FORBIDDEN, "Forbidden");
    appLogger.info("Closed realtime connection whose space access was revoked", {
      spaceId,
    });
  };

  const revalidateConnection = async (): Promise<void> => {
    if (websocket.readyState !== 1) return;

    try {
      // Document-level grantees may have no space role.
      await verifyAccess(
        platform,
        spaceId,
        { type: ResourceType.SPACE, id: spaceId, anyGrantInSpace: true },
        userId,
        Permission.VIEWER,
      );
    } catch (error) {
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

  // Serialize passes so bursts cannot race room eviction.
  let pendingRevalidation: Promise<void> = Promise.resolve();
  const scheduleRevalidation = (): void => {
    pendingRevalidation = pendingRevalidation
      .then(() => requestScope.within(revalidateConnection))
      .catch((error) => {
        appLogger.warn("Failed to re-authorize realtime connection", { error, spaceId });
      });
  };
  const offAuthorizationChanges = subscribeToAuthorizationChanges((change) => {
    if (change.spaceId !== spaceId && change.userId !== userId) return;

    websocket.send(
      wsEncode(WsMsgType.AccessChanged, { scope: "space", access: "refresh" }),
    );
    noteAclChange(spaceId);
    scheduleRevalidation();
  });

  const message = async (frame: Uint8Array): Promise<void> => {
    // Hoisted so the failure below can name the frame it was handling; the
    // client logs the payload, and "Invalid message" alone identifies nothing.
    let frameType: WsMsgType | null = null;
    try {
      const { type, payload } = wsDecode(frame);
      frameType = type;

      if (type === WsMsgType.Ping) {
        websocket.send(wsEncode(WsMsgType.Pong, {}));
        scheduleRevalidation();
        return;
      }

      for (const handler of handlers) {
        if (await handler.handle(type, payload)) return;
      }

      throw new Error("Unsupported message type");
    } catch (error) {
      const frame = wsMsgTypeName(frameType);
      appLogger.warn("Failed to handle realtime message", { error, spaceId, frame });
      websocket.send(
        wsEncode(WsMsgType.Error, {
          message: "Invalid message",
          scope: "frame",
          frame,
        } satisfies RealtimeErrorPayload),
      );
    }
  };

  return {
    // One scope per frame, so its checks share one identity and space lookup.
    message: (frame) => requestScope.within(() => message(frame)),
    close() {
      offAuthorizationChanges();
      for (const handler of handlers) handler.close();
      appLogger.info("Realtime WebSocket connection closed", { spaceId });
    },
  };
}
