import { type AIChatMessage, type AIChatSession, api } from "../api/client.ts";

export type UIMessage = AIChatMessage;
export type ChatSession = AIChatSession;

export async function getSessionsForSpace(spaceId: string): Promise<ChatSession[]> {
  return api.aiChatSessions.list(spaceId);
}

export async function getSession(
  spaceId: string,
  sessionId: string,
): Promise<ChatSession | null> {
  return api.aiChatSessions.get(spaceId, sessionId);
}

export async function saveSession(session: ChatSession): Promise<void> {
  return api.aiChatSessions.save(session);
}

export async function deleteSession(spaceId: string, id: string): Promise<void> {
  return api.aiChatSessions.delete(spaceId, id);
}
