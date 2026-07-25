import type { Ref } from "vue";
import { api } from "#api/client.ts";
import type { UIMessage } from "#composeables/useChatSessions.ts";
import { fetchStreamingCompletion } from "./ai-chat/providers/shared.ts";
import type { ChatStreamEvent } from "./ai-chat/types.ts";

type MessageIndex = { value: number | null };

export function useAIChat(options: {
  currentSessionId: Readonly<Ref<string | null>>;
  currentSpaceId: Readonly<Ref<string | null | undefined>>;
  documentId: () => string;
  messages: Ref<UIMessage[]>;
  isGenerating: Ref<boolean>;
  refreshCurrentSession: () => Promise<void>;
  scrollToBottomIfFollowing: () => void;
  scrollThinkingToBottom: () => void;
}) {
  let abortController: AbortController | null = null;

  function buildDocumentReferenceContext(message: string): string {
    const references: Array<{ id: string; title: string }> = [];
    const seen = new Set<string>();
    const regex = /(?:@\[([^\]]+)\]|\[@([^\]]+)\])\(doc:([^)]+)\)/g;
    for (const match of message.matchAll(regex)) {
      const title = (match[1] ?? match[2])?.trim();
      const id = match[3]?.trim();
      if (!title || !id || seen.has(id)) continue;
      seen.add(id);
      references.push({ id, title });
    }
    if (references.length === 0) return "";
    const lines = references.map((document) =>
      `- ${document.title} (documentId: ${document.id})`,
    );
    return `Referenced documents:\n${lines.join("\n")}\nUse these document IDs with tools when relevant.`;
  }

  function appendAssistantMessageChunk(text: string, index: MessageIndex) {
    if (!text) return;
    const existing = index.value === null ? null : options.messages.value[index.value];
    if (existing?.role !== "assistant") {
      options.messages.value.push({
        role: "assistant",
        content: text,
        timestamp: Date.now(),
      });
      index.value = options.messages.value.length - 1;
      return;
    }
    existing.content += text;
  }

  function appendThinkingMessageChunk(text: string, index: MessageIndex) {
    if (!text) return;
    const existing = index.value === null ? null : options.messages.value[index.value];
    if (existing?.role !== "thinking") {
      options.messages.value.push({
        role: "thinking",
        content: text,
        timestamp: Date.now(),
      });
      index.value = options.messages.value.length - 1;
    } else {
      existing.content += text;
    }
    options.scrollThinkingToBottom();
  }

  function appendToolEventMessage(
    event: Extract<ChatStreamEvent, { type: "tool_call" | "tool_result" }>,
  ) {
    options.messages.value.push({
      role: "tool",
      content: event.type === "tool_call" ? event.toolArguments : event.content,
      timestamp: Date.now(),
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      toolPhase: event.type === "tool_call" ? "call" : "result",
      isError: event.type === "tool_result" ? event.isError : false,
    });
  }

  function removeThinkingMessages(startIndex: number) {
    options.messages.value = options.messages.value.filter(
      (message, index) => !(index >= startIndex && message.role === "thinking"),
    );
  }

  function appendStatusMessage(text: string) {
    const lastMessage = options.messages.value.at(-1);
    if (lastMessage?.role === "status") {
      const lines = lastMessage.content.split("\n").filter(Boolean);
      if (lines.at(-1) !== text) {
        lastMessage.content = `${lastMessage.content}\n${text}`;
      }
      lastMessage.timestamp = Date.now();
      return;
    }

    options.messages.value.push({
      role: "status",
      content: text,
      timestamp: Date.now(),
    });
  }

  function clearTransientStatusMessages(startIndex: number) {
    options.messages.value = options.messages.value.filter(
      (message, index) => !(index >= startIndex && message.role === "status"),
    );
  }

  function applyStreamEvent(
    event: ChatStreamEvent,
    assistantMessageIndex: MessageIndex,
    thinkingMessageIndex: MessageIndex,
    responseStartIndex: number,
  ) {
    if (event.type === "text") {
      removeThinkingMessages(responseStartIndex);
      appendAssistantMessageChunk(event.text, assistantMessageIndex);
    } else if (event.type === "thinking") {
      appendThinkingMessageChunk(event.text, thinkingMessageIndex);
    } else if (event.type === "status") {
      appendStatusMessage(event.text);
    } else if (event.type !== "tool_progress") {
      removeThinkingMessages(responseStartIndex);
      assistantMessageIndex.value = null;
      thinkingMessageIndex.value = null;
      if (event.type === "tool_call") {
        clearTransientStatusMessages(responseStartIndex);
      }
      appendToolEventMessage(event);
    }
    options.scrollToBottomIfFollowing();
  }

  async function streamAssistantResponse(
    userMessage: string,
    responseStartIndex: number,
    additionalContext = "",
  ) {
    const assistantMessageIndex: MessageIndex = { value: null };
    const thinkingMessageIndex: MessageIndex = { value: null };
    const sessionId = options.currentSessionId.value;
    const spaceId = options.currentSpaceId.value;
    if (!sessionId || !spaceId) return;

    await fetchStreamingCompletion({
      url: "/api/v1/chat/acp",
      sessionId,
      spaceId,
      documentId: options.documentId() || undefined,
      userMessage,
      additionalContext: additionalContext || undefined,
      onEvent: (event) =>
        applyStreamEvent(
          event,
          assistantMessageIndex,
          thinkingMessageIndex,
          responseStartIndex,
        ),
      signal: abortController?.signal,
    });
  }

  async function completeResponse(userMessage: string, additionalContext = "") {
    if (options.isGenerating.value || !options.currentSessionId.value) return;
    options.isGenerating.value = true;
    abortController = new AbortController();
    const responseStartIndex = options.messages.value.length;

    try {
      await streamAssistantResponse(userMessage, responseStartIndex, additionalContext);
      await options.refreshCurrentSession();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const errorMessage = error instanceof Error ? error.message : "AI generation failed";
        options.messages.value.push({
          role: "assistant",
          content: `Sorry, I encountered an error: ${errorMessage}`,
          timestamp: Date.now(),
        });
      }
    } finally {
      clearTransientStatusMessages(responseStartIndex);
      removeThinkingMessages(responseStartIndex);
      abortController = null;
      options.isGenerating.value = false;
      options.scrollToBottomIfFollowing();
    }
  }

  async function reconnectSession(pendingUserMessage: string) {
    await completeResponse(
      pendingUserMessage,
      buildDocumentReferenceContext(pendingUserMessage),
    );
  }

  function cancelGeneration() {
    const sessionId = options.currentSessionId.value;
    const spaceId = options.currentSpaceId.value;
    if (sessionId && spaceId) {
      void api.aiChatSessions.cancel(spaceId, sessionId);
    }
    abortController?.abort();
    abortController = null;
  }

  return {
    buildDocumentReferenceContext,
    completeResponse,
    reconnectSession,
    cancelGeneration,
  };
}
