export const realtimeTopics = {
  acl: "space:acl",
  categories: "space:categories",
  categoryDocuments: "space:category-documents",
  documentTree: "space:document-tree",
  documents: "space:documents",
  properties: "space:properties",
  document: (documentId: string) => `document:${documentId}`,
} as const;

export type RealtimeTopic = string;
export type RealtimeEventData = Record<string, unknown> | null;

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
}

export function isDocumentRealtimeTopic(topic: string): topic is `document:${string}` {
  return topic.startsWith("document:") && topic.length > "document:".length;
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
} as const;

export type WsMsgType = typeof WsMsgType[keyof typeof WsMsgType];

const enc = new TextEncoder();
const dec = new TextDecoder();

export function wsEncode(type: WsMsgType, payload: object): Uint8Array {
  const json = enc.encode(JSON.stringify(payload));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = type;
  frame.set(json, 1);
  return frame;
}

export function wsEncodeYjsUpdate(documentId: string, update: Uint8Array): Uint8Array {
  const idBytes = enc.encode(documentId);
  const frame = new Uint8Array(1 + 4 + idBytes.length + update.length);
  frame[0] = WsMsgType.YjsUpdate;
  new DataView(frame.buffer).setUint32(1, idBytes.length, false);
  frame.set(idBytes, 5);
  frame.set(update, 5 + idBytes.length);
  return frame;
}

export function wsDecode(data: Uint8Array): { type: WsMsgType; payload: Uint8Array } {
  return { type: data[0] as WsMsgType, payload: data.subarray(1) };
}

export function wsDecodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(dec.decode(payload)) as T;
}

export function wsDecodeYjsUpdate(payload: Uint8Array): { documentId: string; update: Uint8Array } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const idLength = view.getUint32(0, false);
  return {
    documentId: dec.decode(payload.subarray(4, 4 + idLength)),
    update: payload.subarray(4 + idLength),
  };
}
