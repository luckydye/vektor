/**
 * The canvas half of one realtime connection: the canvas rooms it joined,
 * which of those it may write to, and the frames that carry records.
 */

import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import {
  canvasJoinedPayload,
  canvasRoom,
  leaveCanvasRoom,
  roomWorkingSet,
  submitCanvasOps,
} from "./canvasRooms.ts";
import {
  type CanvasJoinedPayload,
  decodeCanvasOps,
  type RealtimeErrorPayload,
  type RealtimeSocket,
  WsMsgType,
  wsDecodeDocumentFrame,
  wsEncode,
  wsEncodeDocumentFrame,
} from "./protocol.ts";
import { aclVersion, authorizeDocumentRoom, ROOM_AUTH_TTL_MS } from "./yjsConnection.ts";

interface JoinedCanvas {
  canEdit: boolean;
  verifiedAt: number;
  aclVersion: number;
}

export class CanvasConnection {
  readonly joined = new Map<string, JoinedCanvas>();

  constructor(
    readonly platform: Platform,
    readonly spaceId: string,
    readonly userId: string,
    readonly websocket: RealtimeSocket,
  ) {}

  async handle(type: WsMsgType, payload: Uint8Array): Promise<boolean> {
    if (type === WsMsgType.CanvasJoin) {
      await this.join(wsDecodeDocumentFrame(payload).documentId);
      return true;
    }
    if (type === WsMsgType.CanvasLeave) {
      this.leave(wsDecodeDocumentFrame(payload).documentId);
      return true;
    }
    if (type === WsMsgType.CanvasOps) {
      const frame = wsDecodeDocumentFrame(payload);
      await this.ops(frame.documentId, frame.payload);
      return true;
    }
    return false;
  }

  holdsRoom(documentId: string): boolean {
    return this.joined.has(documentId);
  }

  close(): void {
    for (const documentId of [...this.joined.keys()]) this.leave(documentId);
  }

  async revalidate(): Promise<void> {
    for (const documentId of [...this.joined.keys()])
      await this.revalidateRoom(documentId);
  }

  async join(documentId: string): Promise<void> {
    const { access, checkedAt, version } = await authorizeDocumentRoom(
      this.platform,
      this.spaceId,
      this.userId,
      documentId,
    );
    if (access !== "edit" && access !== "view") {
      this.refuse(documentId, "You do not have access to this document");
      return;
    }
    const room = canvasRoom(this.spaceId, documentId);
    let ws: Awaited<ReturnType<typeof roomWorkingSet>>;
    try {
      ws = await roomWorkingSet(this.platform, room);
    } catch (error) {
      appLogger.error("Failed to open a canvas", {
        error,
        spaceId: this.spaceId,
        documentId,
      });
      this.refuse(documentId, "This canvas could not be loaded");
      return;
    }
    if (this.websocket.readyState !== 1) return;
    // Joined before the acknowledgement, in one tick: every record ordered
    // after the `seq` it carries reaches this socket.
    room.clients.add(this.websocket);
    room.idleSince = null;
    this.joined.set(documentId, {
      canEdit: access === "edit",
      verifiedAt: checkedAt,
      aclVersion: version,
    });
    this.websocket.send(
      wsEncodeDocumentFrame(
        WsMsgType.CanvasJoined,
        documentId,
        new TextEncoder().encode(
          JSON.stringify(canvasJoinedPayload(ws) satisfies CanvasJoinedPayload),
        ),
      ),
    );
  }

  leave(documentId: string): void {
    if (!this.joined.delete(documentId)) return;
    leaveCanvasRoom(this.platform, canvasRoom(this.spaceId, documentId), this.websocket);
  }

  async ops(documentId: string, payload: Uint8Array): Promise<void> {
    let joined = this.joined.get(documentId);
    if (!joined) return;
    if (
      joined.aclVersion !== aclVersion(this.spaceId) ||
      Date.now() - joined.verifiedAt >= ROOM_AUTH_TTL_MS
    ) {
      joined = await this.revalidateRoom(documentId);
    }
    // A viewer never produces records; dropped without an echo.
    if (!joined?.canEdit) return;
    const ops = decodeCanvasOps(payload, true);
    await submitCanvasOps(this.platform, canvasRoom(this.spaceId, documentId), {
      epoch: ops.epoch as string,
      opId: ops.opId,
      records: ops.records,
    });
  }

  refuse(documentId: string, message: string): void {
    this.websocket.send(
      wsEncode(WsMsgType.Error, {
        message,
        scope: "canvas-join",
        documentId,
      } satisfies RealtimeErrorPayload),
    );
  }

  async revalidateRoom(documentId: string): Promise<JoinedCanvas | undefined> {
    if (!this.joined.has(documentId)) return undefined;
    const { access, checkedAt, version } = await authorizeDocumentRoom(
      this.platform,
      this.spaceId,
      this.userId,
      documentId,
    );
    const joined = this.joined.get(documentId);
    if (!joined) return undefined;
    // A failed ACL read is not a revocation.
    if (access === "unknown") return joined;
    if (access === "none") {
      this.leave(documentId);
      this.websocket.send(
        wsEncode(WsMsgType.AccessChanged, {
          scope: "document",
          resourceId: documentId,
          access: "none",
        }),
      );
      return undefined;
    }
    const changed = joined.canEdit !== (access === "edit");
    joined.canEdit = access === "edit";
    joined.verifiedAt = checkedAt;
    joined.aclVersion = version;
    if (changed) {
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
}
