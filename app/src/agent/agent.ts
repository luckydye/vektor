import { Bash } from "just-bash";
import {
  createAgentShell,
  type AgentEvent,
  type AgentResult,
  type ChatMessage,
  runAgentPrompt,
} from "./core.ts";
import type { VektorMcpConfig } from "../utils/vektorMcp.ts";

export type { AgentResult, ChatMessage };
export type { AgentEvent };
export { runAgentPrompt } from "./core.ts";

type AgentSession = {
  bash: Bash;
  mcpConfigRef: { current: VektorMcpConfig };
  updatedAt: number;
};

const sessionStore = new Map<string, AgentSession>();
const SESSION_TTL_MS = 1000 * 60 * 60;

function getSessionKey(options: {
  chatId: string;
  spaceId: string;
  documentId?: string;
}): string {
  return `${options.spaceId}:${options.documentId ?? ""}:${options.chatId}`;
}

function sweepExpiredSessions(now: number) {
  for (const [key, session] of sessionStore.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessionStore.delete(key);
    }
  }
}

function getOrCreateSession(options: {
  chatId: string;
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
}): AgentSession {
  const now = Date.now();
  sweepExpiredSessions(now);
  const key = getSessionKey(options);
  const existing = sessionStore.get(key);
  if (existing) {
    existing.mcpConfigRef.current = {
      apiUrl: options.apiUrl,
      spaceId: options.spaceId,
      jobToken: options.jobToken,
      documentId: options.documentId,
    };
    existing.updatedAt = now;
    return existing;
  }

  const mcpConfigRef = {
    current: {
      apiUrl: options.apiUrl,
      spaceId: options.spaceId,
      jobToken: options.jobToken,
      documentId: options.documentId,
    } satisfies VektorMcpConfig,
  };
  const session = {
    bash: createAgentShell(mcpConfigRef),
    mcpConfigRef,
    updatedAt: now,
  };
  sessionStore.set(key, session);
  return session;
}

export async function runAgentInWorker(options: {
  chatId: string;
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentResult> {
  const session = getOrCreateSession(options);
  return await runAgentPrompt({
    ...options,
    bash: session.bash,
  });
}
