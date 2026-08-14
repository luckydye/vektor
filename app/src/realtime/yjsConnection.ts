/**
 * The Yjs half of one realtime connection: the rooms it joined, which of those
 * it may write to, and the frames that carry document state.
 */

import type { WebSocket } from "ws";
import * as Y from "yjs";
import { isAccessDenied, verifyDocumentRole } from "#acl/guards.ts";
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

/**
 * What a connection may do in a document room. `unknown` is not a verdict: the
 * ACL could not be read, so a join fails closed while a room already held keeps
 * the verdict it has until a real one arrives.
 */
type RoomAccess = "edit" | "view" | "none" | "unknown";

/**
 * A room this connection has joined: what it may do there, and when that was
 * last verified against the ACL.
 */
interface JoinedRoom {
  canEdit: boolean;
  verifiedAt: number;
  aclVersion: number;
}

/**
 * How long a write may ride a cached verdict. `applyUpdate` is the hottest path
 * in the server (one frame per keystroke per client), so it re-verifies a stale
 * room instead of querying per update: one DB round trip per room per five
 * seconds rather than one per keystroke.
 */
const ROOM_AUTH_TTL_MS = 5_000;

/**
 * ACL change versions, scoped to a space. A verdict is usable only when the
 * version is unchanged throughout its authorization query.
 */
const aclVersions = new Map<string, number>();

/** Marks cached room verdicts for `spaceId` stale; called when its ACL event lands. */
export function noteAclChange(spaceId: string): void {
  aclVersions.set(spaceId, (aclVersions.get(spaceId) ?? 0) + 1);
}

function aclVersion(spaceId: string): number {
  return aclVersions.get(spaceId) ?? 0;
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

  /** Whether the Yjs half of this connection still holds `documentId`'s room. */
  holdsRoom(documentId: string): boolean {
    return this.joinedRooms.has(`${this.spaceId}:${documentId}`);
  }

  private async join(documentId: string): Promise<void> {
    const { access, checkedAt, version } = await this.authorizeCurrentRoom(documentId);
    if (access !== "edit" && access !== "view") {
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
      verifiedAt: checkedAt,
      aclVersion: version,
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
      joined.aclVersion !== aclVersion(this.spaceId) ||
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
    if (!this.joinedRooms.has(roomKey)) return undefined;

    const documentId = roomKey.slice(this.spaceId.length + 1);
    const { access, checkedAt, version } = await this.authorizeCurrentRoom(documentId);

    // Another pass may have evicted the room while this one was in flight, and
    // a verdict must never put the connection back into a room it has left.
    const joined = this.joinedRooms.get(roomKey);
    if (!joined) return undefined;

    // Only a verdict withdraws a room. An ACL that could not be read leaves the
    // verdict as it stands — stale, so the next update checks again — because
    // evicting here would drop an authorized editor on a failed query.
    if (access === "unknown") {
      appLogger.warn("Could not re-authorize a realtime room; keeping the verdict", {
        spaceId: this.spaceId,
        documentId,
      });
      return joined;
    }

    if (access === "none") {
      this.leaveRoom(roomKey);
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      appLogger.info("Evicted realtime connection from a room it lost access to", {
        spaceId: this.spaceId,
        documentId,
      });
      return undefined;
    }

    joined.canEdit = access === "edit";
    joined.verifiedAt = checkedAt;
    joined.aclVersion = version;
    return joined;
  }

  /**
   * Gets a room verdict that was checked entirely against one observed ACL
   * version. If an ACL event lands during the query, repeat it rather than
   * briefly authorizing the old result.
   */
  private async authorizeCurrentRoom(
    documentId: string,
  ): Promise<{ access: RoomAccess; checkedAt: number; version: number }> {
    while (true) {
      const version = aclVersion(this.spaceId);
      const checkedAt = Date.now();
      const access = await this.authorizeRoom(documentId);
      if (version === aclVersion(this.spaceId)) {
        return { access, checkedAt, version };
      }
    }
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
    const asEditor = await this.holdsRole(documentId, Permission.EDITOR);
    if (asEditor !== "denied") return asEditor === "held" ? "edit" : "unknown";

    const asViewer = await this.holdsRole(documentId, Permission.VIEWER);
    if (asViewer === "unknown") return "unknown";
    return asViewer === "held" ? "view" : "none";
  }

  private async holdsRole(
    documentId: string,
    role: Permission,
  ): Promise<"held" | "denied" | "unknown"> {
    try {
      await verifyDocumentRole(this.spaceId, documentId, this.userId, role);
      return "held";
    } catch (error) {
      return isAccessDenied(error) ? "denied" : "unknown";
    }
  }
}
