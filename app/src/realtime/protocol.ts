import type { PublicUserAppearance } from "#cosmetics/types.ts";

export const realtimeTopics = {
  acl: "space:acl",
  categories: "space:categories",
  categoryDocuments: "space:category-documents",
  documentTree: "space:document-tree",
  documents: "space:documents",
  /** Installed extensions or their enabled state changed. */
  extensions: "space:extensions",
  properties: "space:properties",
  document: (documentId: string) => `document:${documentId}`,
  /** Any workflow run in the space changed (list views) */
  workflowRuns: "space:workflow-runs",
  /** A specific workflow run changed (detail view) */
  workflowRun: (runId: string) => `workflow-run:${runId}`,
} as const;

/** Application close codes for an authorization refusal. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

export type RealtimeTopic = string;
type RealtimeEventData = Record<string, unknown> | null;

export interface RealtimeTopicEvent {
  topic: RealtimeTopic;
  data?: RealtimeEventData;
}

export type RealtimeEventInput = RealtimeTopic | RealtimeTopicEvent;

export interface RealtimeEventMessage {
  type: "event";
  topics: RealtimeTopic[];
  events: RealtimeTopicEvent[];
  timestamp: string;
  /**
   * Synthesised after a reconnect, standing in for the events missed while the
   * socket was down. Carries no per-event `data`, so subscribers that filter on
   * `data` must refetch on it regardless.
   */
  resync?: true;
}

export interface RealtimeAccessChangedMessage {
  type: "access-changed";
  scope: "space" | "document";
  access: "refresh" | "edit" | "view" | "none";
  resourceId?: string;
}

export interface PresenceUser {
  // Deliberately no email: presence is broadcast to every room participant
  // (viewer role), so it must not carry PII. Avatars/colors seed by `id`.
  id: string;
  name: string;
  image?: string | null;
  color?: string | null;
  appearance?: PublicUserAppearance;
}

export interface PresenceJoinPayload<TState = unknown> {
  room: string;
  clientId: string;
  user: PresenceUser;
  state?: TState;
}

export interface PresenceUpdatePayload<TState = unknown> {
  room: string;
  clientId: string;
  state: TState;
}

export interface PresenceLeavePayload {
  room: string;
  clientId: string;
}

export interface PresenceEnvelope<TState = unknown> {
  room: string;
  clientId: string;
  user: PresenceUser;
  state: TState | null;
  updatedAt: string;
}

export interface PresenceSnapshotMessage<TState = unknown> {
  type: "presence-snapshot";
  room: string;
  presences: PresenceEnvelope<TState>[];
}

export interface PresenceUpdateMessage<TState = unknown> {
  type: "presence-update";
  presence: PresenceEnvelope<TState>;
}

export interface PresenceLeaveMessage {
  type: "presence-leave";
  room: string;
  clientId: string;
  timestamp: string;
}

export type PresenceMessage<TState = unknown> =
  | PresenceSnapshotMessage<TState>
  | PresenceUpdateMessage<TState>
  | PresenceLeaveMessage;

const EXTENSION_PRESENCE_ROOM_PREFIX = "extension:";

/**
 * A namespaced, ephemeral presence room owned by an installed extension.
 *
 * Extension code should create these through `ctx.presence.connect()` rather
 * than calling the websocket API directly. Keeping the extension id in the
 * room name lets the realtime server apply extension ACLs without confusing
 * the room with a document id.
 */
export function extensionPresenceRoom(extensionId: string, room: string): string {
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(extensionId)) {
    throw new Error("Invalid extension id for presence room");
  }
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(room)) {
    throw new Error(
      "Presence room names may contain only letters, numbers, '.', '_' and '-'",
    );
  }
  return `${EXTENSION_PRESENCE_ROOM_PREFIX}${extensionId}:${room}`;
}

/** Returns the owning extension id, or null when this is not an extension room. */
export function extensionIdFromPresenceRoom(room: string): string | null {
  if (!room.startsWith(EXTENSION_PRESENCE_ROOM_PREFIX)) return null;
  const match = /^extension:([a-zA-Z0-9._-]{1,96}):[a-zA-Z0-9._-]{1,96}$/.exec(room);
  return match?.[1] ?? "";
}

export function isDocumentRealtimeTopic(topic: string): topic is `document:${string}` {
  return topic.startsWith("document:") && topic.length > "document:".length;
}

export function isWorkflowRunRealtimeTopic(
  topic: string,
): topic is `workflow-run:${string}` {
  return topic.startsWith("workflow-run:") && topic.length > "workflow-run:".length;
}

export function toRealtimeTopicEvent(input: RealtimeEventInput): RealtimeTopicEvent {
  return typeof input === "string" ? { topic: input } : input;
}

// Binary WebSocket protocol
// All frames: [1 byte: WsMsgType][payload bytes]
// Payload for types 0-4: UTF-8 JSON (omitting the redundant `type` field)
// Payload for YjsUpdate (5): [4B: docId length BE][docId UTF-8][Y.js update bytes]

export const WsMsgType = {
  Subscribe: 0,
  Unsubscribe: 1,
  Event: 2,
  Error: 3,
  YjsJoin: 4,
  YjsUpdate: 5,
  PresenceJoin: 6,
  PresenceUpdate: 7,
  PresenceLeave: 8,
  PresenceSnapshot: 9,
  /**
   * Liveness probe, client to server, answered with `Pong`. Protocol pings are
   * answered by the browser and never reach script, so only a round trip the
   * page can observe detects a half-open socket.
   */
  Ping: 10,
  Pong: 11,
  AccessChanged: 12,
  YjsSyncRequest: 13,
} as const;

export type WsMsgType = (typeof WsMsgType)[keyof typeof WsMsgType];

/**
 * Payload of an `Error` frame. `documentId` is what makes one actionable: it
 * names the Yjs join to reject rather than leaving it to time out.
 */
export interface RealtimeErrorPayload {
  message?: string;
  /** Where the failure happened, for logs; the client branches on the fields. */
  scope?: "yjs-join" | "yjs-room" | "presence-join" | "frame";
  /** Set only for a Yjs room: it is what the client rejects the join against. */
  documentId?: string;
  /** Presence room the failure belongs to, which is not always a document. */
  room?: string;
  /** Name of the frame being handled, for a failure that decoded far enough. */
  frame?: string;
}

const wsMsgTypeNames = new Map<number, string>(
  Object.entries(WsMsgType).map(([name, value]) => [value, name]),
);

/** Names a frame for logs and error payloads, where the number explains nothing. */
export function wsMsgTypeName(type: number | null | undefined): string {
  if (type === null || type === undefined) return "undecoded";
  return wsMsgTypeNames.get(type) ?? `unknown(${type})`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function wsEncode(type: WsMsgType, payload: object): Uint8Array<ArrayBuffer> {
  const json = enc.encode(JSON.stringify(payload));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = type;
  frame.set(json, 1);
  return frame;
}

export function wsEncodeYjsUpdate(
  documentId: string,
  update: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return wsEncodeYjsBinary(WsMsgType.YjsUpdate, documentId, update);
}

export function wsEncodeYjsSyncRequest(
  documentId: string,
  stateVector: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return wsEncodeYjsBinary(WsMsgType.YjsSyncRequest, documentId, stateVector);
}

function wsEncodeYjsBinary(
  type: WsMsgType,
  documentId: string,
  body: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const idBytes = enc.encode(documentId);
  const frame = new Uint8Array(1 + 4 + idBytes.length + body.length);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, idBytes.length, false);
  frame.set(idBytes, 5);
  frame.set(body, 5 + idBytes.length);
  return frame;
}

export function wsDecode(data: Uint8Array): { type: WsMsgType; payload: Uint8Array } {
  return { type: data[0] as WsMsgType, payload: data.subarray(1) };
}

export function wsDecodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(dec.decode(payload)) as T;
}

export function wsDecodeYjsUpdate(payload: Uint8Array): {
  documentId: string;
  update: Uint8Array;
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const idLength = view.getUint32(0, false);
  return {
    documentId: dec.decode(payload.subarray(4, 4 + idLength)),
    update: payload.subarray(4 + idLength),
  };
}
