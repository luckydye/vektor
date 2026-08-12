/**
 * The Yjs half of one realtime connection: the rooms it joined, which of those
 * it may write to, and the frames that carry document state.
 */

import type { WebSocket } from "ws";
import * as Y from "yjs";
import { verifyDocumentRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { appLogger } from "#observability/logger.ts";
import { tracedSync } from "#observability/trace.ts";
import {
  WsMsgType,
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

/** What a connection may do in a document room, or `null` for no access at all. */
type RoomAccess = "edit" | "view" | null;

/**
 * A room this connection has joined: what it may do there, and when that was
 * last verified against the ACL.
 */
interface JoinedRoom {
  canEdit: boolean;
  verifiedAt: number;
}

/**
 * How long a write may ride a cached verdict. `applyUpdate` is the hottest path
 * in the server (one frame per keystroke per client), so it re-verifies a stale
 * room instead of querying per update: one DB round trip per room per five
 * seconds rather than one per keystroke.
 */
const ROOM_AUTH_TTL_MS = 5_000;

/**
 * When the ACL last changed anywhere in this process. A verdict stamped at or
 * before it is stale no matter how recent it is, which closes the window
 * between a revocation arriving and the (asynchronous) re-authorization
 * finishing. Process-wide rather than per space: a change in one space only
 * costs unrelated connections a re-verification, so being conservative here
 * fails closed.
 */
let aclChangedAt = 0;

/** Marks every cached room verdict stale; called when a `space:acl` event lands. */
export function noteAclChange(): void {
  aclChangedAt = Date.now();
}

/** Tracks the Yjs rooms belonging to one realtime connection. */
export class YjsConnection {
  private readonly joinedRooms = new Map<string, JoinedRoom>();

  constructor(
    private readonly spaceId: string,
    private readonly userId: string,
    private readonly websocket: WebSocket,
  ) {}

  /** Handles a Yjs frame and returns whether the frame was recognized. */
  async handle(type: WsMsgType, payload: Uint8Array): Promise<boolean> {
    if (type === WsMsgType.YjsJoin) {
      await this.join(wsDecodeJson<{ documentId: string }>(payload).documentId);
      return true;
    }

    if (type === WsMsgType.YjsUpdate) {
      const { documentId, update } = wsDecodeYjsUpdate(payload);
      await this.applyUpdate(documentId, update);
      return true;
    }

    return false;
  }

  close(): void {
    for (const roomKey of [...this.joinedRooms.keys()]) {
      this.leaveRoom(roomKey);
    }
  }

  /**
   * Re-runs the join-time authorization for every joined room, keeping the room
   * with `canEdit` cleared for an editor downgraded to viewer and evicting the
   * connection from the ones it lost entirely. Joining authorizes a room once,
   * so without this a revoked user keeps live read and write until they choose
   * to disconnect.
   */
  async revalidate(): Promise<void> {
    for (const roomKey of [...this.joinedRooms.keys()]) {
      await this.revalidateRoom(roomKey);
    }
  }

  private async join(documentId: string): Promise<void> {
    const access = await this.authorizeRoom(documentId);
    if (access === null) {
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      return;
    }

    const roomKey = `${this.spaceId}:${documentId}`;
    const room = getRoom(this.spaceId, documentId);
    if (!room.doc) {
      room.doc = await loadYDoc(this.spaceId, documentId);
    }

    room.clients.add(this.websocket);
    this.joinedRooms.set(roomKey, {
      canEdit: access === "edit",
      verifiedAt: Date.now(),
    });

    const stateUpdate = tracedSync("yjs.encodeState", () =>
      Y.encodeStateAsUpdate(room.doc as Y.Doc),
    );
    tracedSync("yjs.sendState", () =>
      this.websocket.send(wsEncodeYjsUpdate(documentId, stateUpdate)),
    );
  }

  private async applyUpdate(documentId: string, update: Uint8Array): Promise<void> {
    const roomKey = `${this.spaceId}:${documentId}`;
    // Only editors may mutate the room. A viewer's update is dropped — a
    // read-only client should never produce one anyway.
    let joined = this.joinedRooms.get(roomKey);
    if (!joined) return;

    // A verdict older than the last ACL change, or simply old, is re-checked
    // before it authorizes a write; everything else rides the cached one.
    if (
      joined.verifiedAt <= aclChangedAt ||
      Date.now() - joined.verifiedAt >= ROOM_AUTH_TTL_MS
    ) {
      joined = await this.revalidateRoom(roomKey);
    }
    if (!joined?.canEdit) return;

    const room = yRooms.get(roomKey);
    if (!room?.doc) return;

    tracedSync("yjs.applyUpdate", () =>
      Y.applyUpdate(room.doc as Y.Doc, update, this.websocket),
    );
    scheduleYRoomDraftPersist(roomKey, this.userId);

    const frame = wsEncodeYjsUpdate(documentId, update);
    tracedSync("yjs.broadcast", () => {
      for (const client of room.clients) {
        if (client !== this.websocket && client.readyState === 1) {
          client.send(frame);
        }
      }
    });
  }

  /**
   * Re-authorizes one joined room. Returns the refreshed entry, or `undefined`
   * when access is gone and the connection was evicted from the room.
   */
  private async revalidateRoom(roomKey: string): Promise<JoinedRoom | undefined> {
    const joined = this.joinedRooms.get(roomKey);
    if (!joined) return undefined;

    const documentId = roomKey.slice(this.spaceId.length + 1);
    const access = await this.authorizeRoom(documentId);
    if (access === null) {
      this.leaveRoom(roomKey);
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      appLogger.info("Evicted realtime connection from a room it lost access to", {
        spaceId: this.spaceId,
        documentId,
      });
      return undefined;
    }

    joined.canEdit = access === "edit";
    joined.verifiedAt = Date.now();
    return joined;
  }

  /** Drops this connection out of one room, persisting what the room holds. */
  private leaveRoom(roomKey: string): void {
    if (!this.joinedRooms.delete(roomKey)) return;

    const room = yRooms.get(roomKey);
    if (!room) return;

    persistYRoomDraftBestEffort(roomKey);
    room.clients.delete(this.websocket);
    if (room.clients.size === 0 && room.presences.size === 0) {
      yRooms.delete(roomKey);
    }
  }

  /**
   * What this connection may do in a document room. Editors get read+write;
   * viewers may still join to receive state (the room is the single source of
   * truth for rendering). Used at join time and on every re-authorization, so
   * the two can never drift apart.
   */
  private async authorizeRoom(documentId: string): Promise<RoomAccess> {
    if (await this.holdsRole(documentId, Permission.EDITOR)) return "edit";
    if (await this.holdsRole(documentId, Permission.VIEWER)) return "view";
    return null;
  }

  private async holdsRole(documentId: string, role: Permission): Promise<boolean> {
    try {
      await verifyDocumentRole(this.spaceId, documentId, this.userId, role);
      return true;
    } catch {
      return false;
    }
  }
}
