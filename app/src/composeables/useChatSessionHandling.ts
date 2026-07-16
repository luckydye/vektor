import { computed, nextTick, type Ref, ref, watch } from "vue";
import {
  type ChatSession,
  deleteSession,
  getSession,
  getSessionsForSpace,
  saveSession,
  type UIMessage,
} from "./useChatSessions.ts";

const welcomeMessage = "Hello! I'm here to help you with this document. Ask me anything!";

type SessionStatus = "generating" | "awaiting" | "idle";

export function useChatSessionHandling(options: {
  currentSpaceId: Readonly<Ref<string | null | undefined>>;
  messages: Ref<UIMessage[]>;
  isGenerating: Ref<boolean>;
  resetDraft: () => void;
  scrollToBottom: () => void;
  reconnectSession: (pendingUserMessage: string) => void | Promise<void>;
}) {
  const currentSessionId = ref<string | null>(null);
  const sessions = ref<ChatSession[]>([]);
  const showSessionPicker = ref(false);
  const sessionStartedAt = computed(() => {
    const session = sessions.value.find((item) => item.id === currentSessionId.value);
    return session?.createdAt ?? options.messages.value[0]?.timestamp ?? null;
  });

  function normalizeSavedMessage(message: UIMessage): UIMessage {
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
    options.messages.value.push({
      role: "assistant",
      content: welcomeMessage,
      timestamp: Date.now(),
    });
  }

  async function loadSessions() {
    const spaceId = options.currentSpaceId.value;
    if (!spaceId) return;
    sessions.value = await getSessionsForSpace(spaceId);
  }

  async function refreshCurrentSession() {
    const spaceId = options.currentSpaceId.value;
    const sessionId = currentSessionId.value;
    if (!spaceId || !sessionId) return;

    const refreshed = await getSession(spaceId, sessionId);
    if (!refreshed) return;

    const index = sessions.value.findIndex((session) => session.id === refreshed.id);
    if (index !== -1) sessions.value[index] = refreshed;
  }

  function getSessionStatus(session: ChatSession): SessionStatus {
    if (session.id === currentSessionId.value && options.isGenerating.value) {
      return "generating";
    }
    const lastMessage = (session.conversationHistory as Array<{ role: string }>).at(-1);
    return lastMessage?.role === "user" ? "awaiting" : "idle";
  }

  function startNewChat() {
    currentSessionId.value = null;
    options.messages.value = [];
    options.resetDraft();
    showSessionPicker.value = false;
    addWelcomeMessage();
  }

  function resumeSession(session: ChatSession) {
    currentSessionId.value = session.id;
    options.resetDraft();
    options.messages.value = (session.messages as UIMessage[]).map(normalizeSavedMessage);
    showSessionPicker.value = false;
    options.scrollToBottom();

    // If the session was interrupted while the agent was responding, the history
    // ends with a user message. Reconnect to that turn (or restart it if the
    // server already finished) after the restored messages have rendered.
    const conversationHistory = session.conversationHistory as Array<{
      role: string;
      content?: string;
    }>;
    const lastMessage = conversationHistory.at(-1);
    if (lastMessage?.role === "user" && typeof lastMessage.content === "string") {
      void nextTick(() => options.reconnectSession(lastMessage.content!));
    }
  }

  async function createSession(title: string) {
    const spaceId = options.currentSpaceId.value;
    if (!spaceId) throw new Error("No active space selected");

    const session: ChatSession = {
      id: crypto.randomUUID(),
      title,
      spaceId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      conversationHistory: [],
    };
    sessions.value.unshift(session);
    currentSessionId.value = session.id;
    await saveSession(session);
  }

  async function removeSession(id: string) {
    const session = sessions.value.find((item) => item.id === id);
    if (!session) return;

    await deleteSession(session.spaceId, id);
    sessions.value = sessions.value.filter((item) => item.id !== id);
    if (currentSessionId.value !== id) return;

    if (sessions.value.length > 0) {
      showSessionPicker.value = true;
      currentSessionId.value = null;
      options.messages.value = [];
    } else {
      startNewChat();
    }
  }

  watch(
    options.currentSpaceId,
    async (spaceId) => {
      if (!spaceId) return;
      await loadSessions();
      if (sessions.value.length > 0) {
        showSessionPicker.value = true;
      } else if (options.messages.value.length === 0) {
        addWelcomeMessage();
      }
    },
    { immediate: true },
  );

  return {
    currentSessionId,
    sessions,
    showSessionPicker,
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
