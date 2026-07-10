import type { WebSocket } from "ws";
import { verifyDocumentRole } from "#db/api.ts";
import {
  type PresenceEnvelope,
  type PresenceJoinPayload,
  type PresenceLeavePayload,
  type PresenceUpdatePayload,
  WsMsgType,
  wsDecodeJson,
  wsEncode,
} from "#utils/realtime.ts";
import { getRoom, type YRoom, yRooms } from "#utils/yjsRooms.ts";

function broadcastPresence(
  room: YRoom,
  sender: WebSocket,
  type: WsMsgType,
  payload: object,
): void {
  const frame = wsEncode(type, payload);
  for (const client of room.clients) {
    if (client === sender || client.readyState !== 1) {
      continue;
    }
    client.send(frame);
  }
}

/** Tracks presence registrations belonging to one realtime connection. */
export class PresenceConnection {
  private readonly joinedRooms = new Map<string, Set<string>>();

  constructor(
    private readonly spaceId: string,
    private readonly userId: string,
    private readonly websocket: WebSocket,
  ) {}

  /** Handles a presence frame and returns whether the frame was recognized. */
  async handle(type: WsMsgType, payload: Uint8Array): Promise<boolean> {
    if (type === WsMsgType.PresenceJoin) {
      await this.join(wsDecodeJson<PresenceJoinPayload>(payload));
      return true;
    }

    if (type === WsMsgType.PresenceUpdate) {
      await this.update(wsDecodeJson<PresenceUpdatePayload>(payload));
      return true;
    }

    if (type === WsMsgType.PresenceLeave) {
      this.leave(wsDecodeJson<PresenceLeavePayload>(payload));
      return true;
    }

    return false;
  }

  close(): void {
    for (const [roomKey, clientIds] of this.joinedRooms.entries()) {
      const room = yRooms.get(roomKey);
      if (!room) {
        continue;
      }

      const roomId = roomKey.slice(this.spaceId.length + 1);
      for (const clientId of clientIds) {
        room.presences.delete(clientId);
        broadcastPresence(room, this.websocket, WsMsgType.PresenceLeave, {
          room: roomId,
          clientId,
          timestamp: new Date().toISOString(),
        });
      }

      room.clients.delete(this.websocket);
      if (room.clients.size === 0 && room.presences.size === 0) {
        yRooms.delete(roomKey);
      }
    }
  }

  private async join(join: PresenceJoinPayload): Promise<void> {
    try {
      await verifyDocumentRole(this.spaceId, join.room, this.userId, "viewer");
    } catch {
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      return;
    }

    const roomKey = `${this.spaceId}:${join.room}`;
    const room = getRoom(this.spaceId, join.room);
    room.clients.add(this.websocket);
    const presence: PresenceEnvelope = {
      room: join.room,
      clientId: join.clientId,
      user: join.user,
      state: join.state ?? null,
      updatedAt: new Date().toISOString(),
    };
    room.presences.set(join.clientId, presence);

    const clientIds = this.joinedRooms.get(roomKey) ?? new Set<string>();
    clientIds.add(join.clientId);
    this.joinedRooms.set(roomKey, clientIds);

    this.websocket.send(
      wsEncode(WsMsgType.PresenceSnapshot, {
        room: join.room,
        presences: [...room.presences.values()],
      }),
    );
    broadcastPresence(room, this.websocket, WsMsgType.PresenceUpdate, { presence });
  }

  private async update(update: PresenceUpdatePayload): Promise<void> {
    try {
      await verifyDocumentRole(this.spaceId, update.room, this.userId, "viewer");
    } catch {
      this.websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      return;
    }

    const room = yRooms.get(`${this.spaceId}:${update.room}`);
    const existingPresence = room?.presences.get(update.clientId);
    if (!room || !existingPresence) {
      return;
    }

    const presence: PresenceEnvelope = {
      ...existingPresence,
      state: update.state,
      updatedAt: new Date().toISOString(),
    };
    room.presences.set(update.clientId, presence);
    broadcastPresence(room, this.websocket, WsMsgType.PresenceUpdate, { presence });
  }

  private leave(leave: PresenceLeavePayload): void {
    const roomKey = `${this.spaceId}:${leave.room}`;
    const room = yRooms.get(roomKey);
    if (!room) {
      return;
    }

    room.presences.delete(leave.clientId);
    this.joinedRooms.get(roomKey)?.delete(leave.clientId);
    broadcastPresence(room, this.websocket, WsMsgType.PresenceLeave, {
      room: leave.room,
      clientId: leave.clientId,
      timestamp: new Date().toISOString(),
    });

    if (room.clients.size === 0 && room.presences.size === 0) {
      yRooms.delete(roomKey);
    }
  }
}
