/**
 * The Yjs half of one realtime connection: the rooms it joined, which of those
 * it may write to, and the frames that carry document state.
 */

import type { WebSocket } from "ws";
import * as Y from "yjs";
import { verifyDocumentRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
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

/** Tracks the Yjs rooms belonging to one realtime connection. */
export class YjsConnection {
  private readonly joinedRooms = new Set<string>();
  /** Rooms this connection may mutate; a viewer joins for state only. */
  private readonly editableRooms = new Set<string>();

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
      this.applyUpdate(documentId, update);
      return true;
    }

    return false;
  }

  close(): void {
    for (const roomKey of this.joinedRooms) {
      const room = yRooms.get(roomKey);
      if (!room) continue;

      persistYRoomDraftBestEffort(roomKey);
      room.clients.delete(this.websocket);
      if (room.clients.size === 0 && room.presences.size === 0) {
        yRooms.delete(roomKey);
      }
    }
  }

  private async join(documentId: string): Promise<void> {
    // Editors get read+write; viewers may still join to receive state (the room
    // is the single source of truth for rendering). No access at all is refused.
    const canEdit = await this.holdsRole(documentId, Permission.EDITOR);
    if (!canEdit && !(await this.holdsRole(documentId, Permission.VIEWER))) {
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      return;
    }

    const roomKey = `${this.spaceId}:${documentId}`;
    const room = getRoom(this.spaceId, documentId);
    if (!room.doc) {
      room.doc = await loadYDoc(this.spaceId, documentId);
    }

    room.clients.add(this.websocket);
    this.joinedRooms.add(roomKey);
    if (canEdit) this.editableRooms.add(roomKey);

    const stateUpdate = tracedSync("yjs.encodeState", () =>
      Y.encodeStateAsUpdate(room.doc as Y.Doc),
    );
    tracedSync("yjs.sendState", () =>
      this.websocket.send(wsEncodeYjsUpdate(documentId, stateUpdate)),
    );
  }

  private applyUpdate(documentId: string, update: Uint8Array): void {
    const roomKey = `${this.spaceId}:${documentId}`;
    // Only editors may mutate the room. A viewer's update is dropped — a
    // read-only client should never produce one anyway.
    if (!this.editableRooms.has(roomKey)) return;

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

  private async holdsRole(documentId: string, role: Permission): Promise<boolean> {
    try {
      await verifyDocumentRole(this.spaceId, documentId, this.userId, role);
      return true;
    } catch {
      return false;
    }
  }
}
