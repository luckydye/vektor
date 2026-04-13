import type { ChatMessage } from "../components/ai-chat/types.ts";

export type UIMessage = {
  role: "user" | "assistant" | "system" | "tool" | "status";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolPhase?: "call" | "result";
  isError?: boolean;
  attachments?: Array<{
    key: string;
    url: string;
    name: string;
    type: string;
    size: number;
    isImage: boolean;
  }>;
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

function getSessionPath(spaceId: string, sessionId?: string): string {
  const encodedSpaceId = encodeURIComponent(spaceId);
  if (!sessionId) {
    return `/api/v1/spaces/${encodedSpaceId}/ai-chat/sessions`;
  }
  return `/api/v1/spaces/${encodedSpaceId}/ai-chat/sessions/${encodeURIComponent(sessionId)}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`AI chat sessions request failed: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function getSessionsForSpace(spaceId: string): Promise<ChatSession[]> {
  const response = await fetch(getSessionPath(spaceId), {
    credentials: "same-origin",
  });
  const { sessions } = await parseResponse<{ sessions: ChatSession[] }>(response);
  return sessions;
}

export async function saveSession(session: ChatSession): Promise<void> {
  const response = await fetch(getSessionPath(session.spaceId, session.id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(session),
  });
  await parseResponse<{ session: ChatSession }>(response);
}

export async function deleteSession(spaceId: string, id: string): Promise<void> {
  const response = await fetch(getSessionPath(spaceId, id), {
    method: "DELETE",
    credentials: "same-origin",
  });
  await parseResponse<{ success: true }>(response);
}
