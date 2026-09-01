/**
 * The Yjs half of one realtime connection: the rooms it joined, which of those
 * it may write to, and the frames that carry document state.
 */

import type { WebSocket } from "ws";
import * as Y from "yjs";
import { isAccessDenied, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { documentIsReadonlyById } from "#db/space/documents.ts";
import { appLogger } from "#observability/logger.ts";
import { tracedSync } from "#observability/trace.ts";
import {
  type RealtimeErrorPayload,
  WsMsgType,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsSyncRequest,
  wsEncodeYjsUpdate,
  type YjsJoinPayload,
  type YjsRoomGenerationPayload,
} from "./protocol.ts";
import {
  ensureRoomDoc,
  getRoom,
  persistYRoomDraftBestEffort,
  retireYRoom,
  scheduleYRoomDraftPersist,
  yRooms,
} from "./yjsRooms.ts";

type RoomAccess = "edit" | "view" | "none" | "unknown";

interface JoinedRoom {
  canEdit: boolean;
  verifiedAt: number;
  aclVersion: number;
  generation: string;
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

function decodeStateVector(encoded: string | undefined): Uint8Array | null {
  if (!encoded) return null;
  try {
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
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
      const join = wsDecodeJson<YjsJoinPayload>(payload);
      await this.join(
        join.documentId,
        join.generation,
        decodeStateVector(join.stateVector),
      );
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

  private async join(
    documentId: string,
    clientGeneration: string | undefined,
    clientStateVector: Uint8Array | null,
  ): Promise<void> {
    const { access, checkedAt, version } = await this.authorizeCurrentRoom(documentId);
    if (access !== "edit" && access !== "view") {
      // The client rejects the pending join on this, so the message is one a
      // person reads in a toast rather than a status word.
      this.websocket.send(
        wsEncode(WsMsgType.Error, {
          message: "You do not have access to this document",
          scope: "yjs-join",
          documentId,
        } satisfies RealtimeErrorPayload),
      );
      return;
    }

    const roomKey = `${this.spaceId}:${documentId}`;
    const doc = await ensureRoomDoc(this.spaceId, documentId);
    // `close()` only visits rooms in `joinedRooms`, which this join has not
    // reached yet, so a socket that dropped during the load would stay in
    // `clients` forever and pin the room and its document.
    if (this.websocket.readyState !== 1) return;

    // Re-read: the room this started from may have been dropped while the
    // document loaded, and updates only reach the one that is registered now.
    const room = getRoom(this.spaceId, documentId);
    const staleGeneration =
      clientGeneration !== undefined && clientGeneration !== room.generation;
    const unversionedHistory = clientStateVector !== null && !clientGeneration;
    if (staleGeneration || unversionedHistory) {
      this.leaveRoom(roomKey);
      this.websocket.send(
        wsEncode(WsMsgType.YjsReset, {
          documentId,
          generation: room.generation,
        } satisfies YjsRoomGenerationPayload),
      );
      return;
    }

    room.clients.add(this.websocket);
    this.joinedRooms.set(roomKey, {
      canEdit: access === "edit",
      verifiedAt: checkedAt,
      aclVersion: version,
      generation: room.generation,
    });

    // The acknowledgement precedes the state frame. The client uses both as a
    // barrier before flushing edits accumulated while its socket was down.
    this.websocket.send(
      wsEncode(WsMsgType.YjsJoined, {
        documentId,
        generation: room.generation,
      } satisfies YjsRoomGenerationPayload),
    );

    const stateUpdate = tracedSync("yjs.encodeState", () =>
      Y.encodeStateAsUpdate(doc, clientStateVector ?? undefined),
    );
    tracedSync("yjs.sendState", () =>
      this.websocket.send(wsEncodeYjsUpdate(documentId, stateUpdate)),
    );

    if (clientStateVector) {
      tracedSync("yjs.sendSyncRequest", () =>
        this.websocket.send(wsEncodeYjsSyncRequest(documentId, Y.encodeStateVector(doc))),
      );
    }
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
    // A room can only change generation after the old one has no clients, but
    // keep the invariant local: a stale socket may never write into a rebuilt
    // transient document.
    if (!room?.doc || room.writeBlocked || joined.generation !== room.generation) return;

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
      this.websocket.send(
        wsEncode(WsMsgType.Error, {
          message: "You no longer have access to this document",
          scope: "yjs-room",
          documentId,
        } satisfies RealtimeErrorPayload),
      );
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

    room.clients.delete(this.websocket);
    if (room.clients.size === 0 && room.presences.size === 0) {
      retireYRoom(roomKey);
    } else {
      persistYRoomDraftBestEffort(roomKey);
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
      await verifyAccess(
        this.spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        this.userId,
        role,
      );
      return "held";
    } catch (error) {
      return isAccessDenied(error) ? "denied" : "unknown";
    }
  }
}
