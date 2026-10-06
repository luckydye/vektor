import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import {
  type AIChatMessage,
  type AIChatSession,
  type AIChatSessionListEntry,
  api,
} from "#api/client.ts";
import { useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";

const welcomeMessage = "Hello! I'm here to help you with this document. Ask me anything!";

type SessionStatus = "generating" | "awaiting" | "idle";

export const chatSessionsQueryKey = (spaceId: string | null | undefined) => [
  "ai-chat-sessions",
  spaceId,
];

/** The space's most recently updated chat sessions; `undefined` until loaded. */
export function useRecentChatSessions(limit: number) {
  const { currentSpaceId } = useSpace();
  const { data } = useQuery({
    queryKey: createMemo(() => chatSessionsQueryKey(currentSpaceId())),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No active space selected");
      return await api.aiChatSessions.list(spaceId);
    },
    enabled: createMemo(() => !!currentSpaceId()),
  });
  return createMemo(() =>
    data()
      ?.filter((session) => session.source === "chat")
      .slice(0, limit),
  );
}

/** The list's view of a session we happen to hold in full. */
function toSummary(session: AIChatSession): AIChatSessionListEntry {
  const lastMessage = (session.conversationHistory as Array<{ role: string }>).at(-1);
  return {
    id: session.id,
    title: session.title,
    spaceId: session.spaceId,
    source: session.source,
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
  /** Attach to the turn the server is running in the current session. */
  reconnectSession: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const invalidateSessionList = () =>
    queryClient.invalidateQueries({ queryKey: chatSessionsQueryKey(options.currentSpaceId()) });
  const [currentSessionId, setCurrentSessionId] = createSignal<string | null>(null);
  const [sessions, setSessions] = createSignal<AIChatSessionListEntry[]>([]);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  /** Sessions opened by jobs, such as workflow runs, are listed only on request. */
  const [showJobSessions, setShowJobSessions] = createSignal(false);
  const visibleSessions = createMemo(() =>
    sessions().filter((session) => showJobSessions() || session.source === "chat"),
  );
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
    const loaded = await api.aiChatSessions.list(spaceId);
    // Sessions created while the list was in flight are not in it yet.
    setSessions((list) => [
      ...list.filter(
        (session) =>
          session.spaceId === spaceId && !loaded.some((item) => item.id === session.id),
      ),
      ...loaded,
    ]);
  }

  async function refreshCurrentSession() {
    const spaceId = options.currentSpaceId();
    const sessionId = currentSessionId();
    if (!spaceId || !sessionId) return;

    const refreshed = await api.aiChatSessions.get(spaceId, sessionId);
    if (!refreshed) return;
    invalidateSessionList();

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

    // A session ending on its user message has a turn running on the server.
    if (session.conversationHistory.at(-1)?.role === "user") {
      void options.reconnectSession();
    }
  }

  async function createSession(title: string) {
    const spaceId = options.currentSpaceId();
    if (!spaceId) throw new Error("No active space selected");

    const id = await api.aiChatSessions.create(spaceId, title);
    const now = Date.now();
    setSessions((list) => [
      {
        id,
        title,
        spaceId,
        source: "chat",
        createdAt: now,
        updatedAt: now,
        lastMessageRole: null,
      },
      ...list,
    ]);
    setCurrentSessionId(id);
    invalidateSessionList();
  }

  async function removeSession(id: string) {
    const session = sessions().find((item) => item.id === id);
    if (!session) return;

    await api.aiChatSessions.delete(session.spaceId, id);
    invalidateSessionList();
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
      // A chat started while the list loaded must not be covered by the picker.
      if (currentSessionId()) return;
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
    visibleSessions,
    showJobSessions,
    setShowJobSessions,
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
