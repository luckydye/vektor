import type { Doc as YDoc } from "yjs";
import { api } from "../api/client.ts";
import type { PresenceMessage, PresenceUser } from "../utils/realtime.ts";

// Returns a cleanup function that disconnects from the Y.js room.
export function joinYjsRoom(
  spaceId: string,
  documentId: string,
  ydoc: YDoc,
  onSynced?: () => void,
): () => void {
  return api.joinYjsRoom(spaceId, documentId, ydoc, onSynced);
}

export function joinPresenceRoom<TState>(
  spaceId: string,
  room: string,
  clientId: string,
  user: PresenceUser,
  callback: (event: PresenceMessage<TState>) => void,
  initialState?: TState,
): { update: (state: TState) => void; leave: () => void } {
  return api.joinPresenceRoom(spaceId, room, clientId, user, callback, initialState);
}
