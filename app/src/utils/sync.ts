import { api } from "../api/client.ts";
import type { PresenceMessage, PresenceUser } from "../utils/realtime.ts";
import type { Doc as YDoc } from "yjs";

// Returns a cleanup function that disconnects from the Y.js room.
export function joinYjsRoom(spaceId: string, documentId: string, ydoc: YDoc): () => void {
  return api.joinYjsRoom(spaceId, documentId, ydoc);
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
