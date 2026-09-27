import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import {
  type AIChatMessage,
  type AIChatSession,
  type AIChatSessionListEntry,
  api,
} from "#api/client.ts";

const welcomeMessage = "Hello! I'm here to help you with this document. Ask me anything!";

type SessionStatus = "generating" | "awaiting" | "idle";

/** The list's view of a session we happen to hold in full. */
function toSummary(session: AIChatSession): AIChatSessionListEntry {
  const lastMessage = (session.conversationHistory as Array<{ role: string }>).at(-1);
  return {
    id: session.id,
    title: session.title,
    spaceId: session.spaceId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageRole: lastMessage?.role ?? null,
  };
}

export function useChatSessionHandling(options: {
  currentSpaceId: Accessor<string | null | undefined>;
  /**
   * Whether the panel is showing. The session list is only worth fetching for
   * a panel someone is looking at — the chat mounts with the shell on every
   * page load, and its history is the largest thing the space can hand out.
   */
  isActive: Accessor<boolean>;
  /**
   * The transcript, as a Solid store. A store rather than a signal because the
   * stream appends to it token by token: `setMessages(i, "content", …)` touches
   * one message, where replacing the array would rerender the whole list.
   */
  messages: Accessor<AIChatMessage[]>;
  setMessages: SetStoreFunction<AIChatMessage[]>;
  isGenerating: Accessor<boolean>;
  resetDraft: () => void;
  scrollToBottom: () => void;
  reconnectSession: (pendingUserMessage: string) => void | Promise<void>;
}) {
  const [currentSessionId, setCurrentSessionId] = createSignal<string | null>(null);
  const [sessions, setSessions] = createSignal<AIChatSessionListEntry[]>([]);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  const sessionStartedAt = createMemo(() => {
    const session = sessions().find((item) => item.id === currentSessionId());
    return session?.createdAt ?? options.messages()[0]?.timestamp ?? null;
  });

  function normalizeSavedMessage(message: AIChatMessage): AIChatMessage {
    return {
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
      timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
      attachments: message.attachments,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      toolPhase: message.toolPhase,
      isError: message.isError,
    };
  }

  function addWelcomeMessage() {
    options.setMessages(options.messages().length, {
      role: "assistant",
      content: welcomeMessage,
      timestamp: Date.now(),
    });
  }

  async function loadSessions() {
    const spaceId = options.currentSpaceId();
    if (!spaceId) return;
    setSessions(await api.aiChatSessions.list(spaceId));
  }

  async function refreshCurrentSession() {
    const spaceId = options.currentSpaceId();
    const sessionId = currentSessionId();
    if (!spaceId || !sessionId) return;

    const refreshed = await api.aiChatSessions.get(spaceId, sessionId);
    if (!refreshed) return;

    setSessions((list) =>
      list.map((session) =>
        session.id === refreshed.id ? toSummary(refreshed) : session,
      ),
    );
  }

  function getSessionStatus(session: AIChatSessionListEntry): SessionStatus {
    if (session.id === currentSessionId() && options.isGenerating()) return "generating";
    return session.lastMessageRole === "user" ? "awaiting" : "idle";
  }

  function startNewChat() {
    setCurrentSessionId(null);
    options.setMessages([]);
    options.resetDraft();
    setShowSessionPicker(false);
    addWelcomeMessage();
  }

  async function resumeSession(summary: AIChatSessionListEntry) {
    // The list carries no transcript, so the picked session is read in full
    // here — one session, rather than every session on every page load.
    const session = await api.aiChatSessions.get(summary.spaceId, summary.id);
    if (!session) return;

    setCurrentSessionId(session.id);
    options.resetDraft();
    options.setMessages((session.messages as AIChatMessage[]).map(normalizeSavedMessage));
    setShowSessionPicker(false);
    options.scrollToBottom();

    // If the session was interrupted while the agent was responding, the history
    // ends with a user message. Reconnect to that turn (or restart it if the
    // server already finished) after the restored messages have rendered — which,
    // in Solid, is as soon as the store write above returns.
    const conversationHistory = session.conversationHistory as Array<{
      role: string;
      content?: string;
    }>;
    const lastMessage = conversationHistory.at(-1);
    if (lastMessage?.role === "user" && typeof lastMessage.content === "string") {
      const pending = lastMessage.content;
      void options.reconnectSession(pending);
    }
  }

  async function createSession(title: string) {
    const spaceId = options.currentSpaceId();
    if (!spaceId) throw new Error("No active space selected");

    const session: AIChatSession = {
      id: crypto.randomUUID(),
      title,
      spaceId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      conversationHistory: [],
    };
    setSessions((list) => [toSummary(session), ...list]);
    setCurrentSessionId(session.id);
    await api.aiChatSessions.save(session);
  }

  async function removeSession(id: string) {
    const session = sessions().find((item) => item.id === id);
    if (!session) return;

    await api.aiChatSessions.delete(session.spaceId, id);
    setSessions((list) => list.filter((item) => item.id !== id));
    if (currentSessionId() !== id) return;

    if (sessions().length > 0) {
      setShowSessionPicker(true);
      setCurrentSessionId(null);
      options.setMessages([]);
    } else {
      startNewChat();
    }
  }

  createEffect(() => {
    const spaceId = options.currentSpaceId();
    if (!spaceId || !options.isActive()) return;
    void loadSessions().then(() => {
      if (sessions().length > 0) {
        setShowSessionPicker(true);
      } else if (options.messages().length === 0) {
        addWelcomeMessage();
      }
    });
  });

  return {
    currentSessionId,
    sessions,
    showSessionPicker,
    setShowSessionPicker,
    sessionStartedAt,
    loadSessions,
    refreshCurrentSession,
    getSessionStatus,
    startNewChat,
    resumeSession,
    createSession,
    removeSession,
  };
}
