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

export interface RealtimeSubscribeMessage {
  type: "subscribe" | "unsubscribe";
  topics: RealtimeTopic[];
}

export interface RealtimeEventMessage {
  type: "event";
  topics: RealtimeTopic[];
  timestamp: string;
}

export interface RealtimeErrorMessage {
  type: "error";
  message: string;
}

export type RealtimeClientMessage = RealtimeSubscribeMessage;
export type RealtimeServerMessage = RealtimeEventMessage | RealtimeErrorMessage;

export function isDocumentRealtimeTopic(topic: string): topic is `document:${string}` {
  return topic.startsWith("document:") && topic.length > "document:".length;
}
