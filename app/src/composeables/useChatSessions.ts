import { IndexedDBStore } from "../utils/storage.ts";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export type UIMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  timestamp: number;
  toolApproval?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: "pending" | "approved" | "denied";
  };
  subAgent?: {
    status: "running" | "completed" | "failed";
    logs: string[];
    result?: string;
    error?: string;
  };
};

export type ChatSession = {
  id: string;
  title: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
  conversationHistory: ChatMessage[];
};

const store = new IndexedDBStore<ChatSession>({
  dbName: "wiki-chat",
  storeName: "sessions",
  keyPath: "id",
  version: 1,
  indexes: [
    { name: "spaceId", keyPath: "spaceId" },
    { name: "updatedAt", keyPath: "updatedAt" },
  ],
});

export async function getSessionsForSpace(spaceId: string): Promise<ChatSession[]> {
  const results = await store.getByIndex("spaceId", spaceId, "prev");
  const normalized = results.map((session) => ({
    ...session,
    messages: Array.isArray(session.messages) ? session.messages : [],
    conversationHistory: Array.isArray(session.conversationHistory)
      ? session.conversationHistory
      : [],
  }));
  return normalized.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveSession(session: ChatSession): Promise<void> {
  // Persist a plain JSON copy so Vue reactive proxies never reach IndexedDB.
  const plainSession = JSON.parse(JSON.stringify(session)) as ChatSession;
  await store.put(plainSession);
}

export async function deleteSession(id: string): Promise<void> {
  await store.delete(id);
}
