/**
 * The Yjs half of one realtime connection: the rooms it joined, which of those
 * it may write to, and the frames that carry document state.
 */

import type { WebSocket } from "ws";
import * as Y from "yjs";
import { isAccessDenied, verifyDocumentRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { documentIsReadonlyById } from "#db/space/documents.ts";
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

type RoomAccess = "edit" | "view" | "none" | "unknown";

interface JoinedRoom {
  canEdit: boolean;
  verifiedAt: number;
  aclVersion: number;
}

/** Avoid an ACL query for every Yjs update while bounding stale writes. */
const ROOM_AUTH_TTL_MS = 5_000;

const aclVersions = new Map<string, number>();

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

  async revalidate(): Promise<void> {
    for (const roomKey of [...this.joinedRooms.keys()]) {
      await this.revalidateRoom(roomKey);
    }
  }

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

    if (
      joined.aclVersion !== aclVersion(this.spaceId) ||
      Date.now() - joined.verifiedAt >= ROOM_AUTH_TTL_MS
    ) {
      joined = await this.revalidateRoom(roomKey);
    }
    if (!joined?.canEdit) return;

    const room = yRooms.get(roomKey);
    if (!room?.doc || room.writeBlocked) return;

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

  private async revalidateRoom(roomKey: string): Promise<JoinedRoom | undefined> {
    if (!this.joinedRooms.has(roomKey)) return undefined;

    const documentId = roomKey.slice(this.spaceId.length + 1);
    const { access, checkedAt, version } = await this.authorizeCurrentRoom(documentId);

    // A concurrent pass may already have evicted the room.
    const joined = this.joinedRooms.get(roomKey);
    if (!joined) return undefined;

    // A failed ACL read is not a revocation.
    if (access === "unknown") {
      appLogger.warn("Could not re-authorize a realtime room; keeping the verdict", {
        spaceId: this.spaceId,
        documentId,
      });
      return joined;
    }

    if (access === "none") {
      this.leaveRoom(roomKey);
      this.websocket.send(
        wsEncode(WsMsgType.AccessChanged, {
          scope: "document",
          resourceId: documentId,
          access: "none",
        }),
      );
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      appLogger.info("Evicted realtime connection from a room it lost access to", {
        spaceId: this.spaceId,
        documentId,
      });
      return undefined;
    }

    const editAccessChanged = joined.canEdit !== (access === "edit");
    joined.canEdit = access === "edit";
    joined.verifiedAt = checkedAt;
    joined.aclVersion = version;
    if (editAccessChanged) {
      this.websocket.send(
        wsEncode(WsMsgType.AccessChanged, {
          scope: "document",
          resourceId: documentId,
          access,
        }),
      );
    }
    return joined;
  }

  /** Retry when an ACL event lands during the authorization query. */
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

  private async authorizeRoom(documentId: string): Promise<RoomAccess> {
    const asEditor = await this.holdsRole(documentId, Permission.EDITOR);
    if (asEditor === "unknown") return "unknown";
    if (asEditor === "held") {
      try {
        return (await documentIsReadonlyById(
          await openSpaceStore(this.spaceId),
          documentId,
        ))
          ? "view"
          : "edit";
      } catch {
        return "unknown";
      }
    }

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
