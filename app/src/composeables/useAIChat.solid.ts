import type { Accessor } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { produce } from "solid-js/store";
import { api } from "#api/client.ts";
import type { UIMessage } from "#composeables/useChatSessions.ts";
import { fetchStreamingCompletion } from "./ai-chat/providers/shared.ts";
import type { ChatStreamEvent } from "./ai-chat/types.ts";

type MessageIndex = { value: number | null };

export type ImageChatAttachment = {
  key: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export type ChatAttachment = {
  key: string;
  name: string;
  type: string;
  size: number;
  isImage: boolean;
};

export function useAIChat(options: {
  currentSessionId: Accessor<string | null>;
  currentSpaceId: Accessor<string | null | undefined>;
  documentId: () => string;
  /**
   * The transcript, as a Solid store. The stream appends token by token, so a
   * per-message write (`setMessages(i, "content", …)`) is what keeps rendering
   * to the one bubble that changed.
   */
  messages: Accessor<UIMessage[]>;
  setMessages: SetStoreFunction<UIMessage[]>;
  isGenerating: Accessor<boolean>;
  setIsGenerating: (value: boolean) => void;
  refreshCurrentSession: () => Promise<void>;
  scrollToBottomIfFollowing: () => void;
  scrollThinkingToBottom: () => void;
}) {
  let abortController: AbortController | null = null;

  function pushMessage(message: UIMessage): number {
    const index = options.messages().length;
    options.setMessages(index, message);
    return index;
  }

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
    const lines = references.map(
      (document) => `- ${document.title} (documentId: ${document.id})`,
    );
    return `Referenced documents:\n${lines.join("\n")}\nUse these document IDs with tools when relevant.`;
  }

  function appendAssistantMessageChunk(text: string, index: MessageIndex) {
    if (!text) return;
    const existing = index.value === null ? null : options.messages()[index.value];
    if (existing?.role !== "assistant") {
      index.value = pushMessage({
        role: "assistant",
        content: text,
        timestamp: Date.now(),
      });
      return;
    }
    options.setMessages(index.value as number, "content", (content) => content + text);
  }

  function appendThinkingMessageChunk(text: string, index: MessageIndex) {
    if (!text) return;
    const existing = index.value === null ? null : options.messages()[index.value];
    if (existing?.role !== "thinking") {
      index.value = pushMessage({
        role: "thinking",
        content: text,
        timestamp: Date.now(),
      });
    } else {
      options.setMessages(index.value as number, "content", (content) => content + text);
    }
    options.scrollThinkingToBottom();
  }

  function appendToolEventMessage(
    event: Extract<ChatStreamEvent, { type: "tool_call" | "tool_result" }>,
  ) {
    pushMessage({
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
    options.setMessages((list) =>
      list.filter(
        (message, index) => !(index >= startIndex && message.role === "thinking"),
      ),
    );
  }

  function appendStatusMessage(text: string) {
    const list = options.messages();
    const lastIndex = list.length - 1;
    const lastMessage = list[lastIndex];
    if (lastMessage?.role === "status") {
      const lines = lastMessage.content.split("\n").filter(Boolean);
      options.setMessages(
        lastIndex,
        produce((message) => {
          if (lines.at(-1) !== text) message.content = `${message.content}\n${text}`;
          message.timestamp = Date.now();
        }),
      );
      return;
    }

    pushMessage({ role: "status", content: text, timestamp: Date.now() });
  }

  function clearTransientStatusMessages(startIndex: number) {
    options.setMessages((list) =>
      list.filter(
        (message, index) => !(index >= startIndex && message.role === "status"),
      ),
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
    imageAttachments: ImageChatAttachment[] = [],
    attachments: ChatAttachment[] = [],
  ) {
    const assistantMessageIndex: MessageIndex = { value: null };
    const thinkingMessageIndex: MessageIndex = { value: null };
    const sessionId = options.currentSessionId();
    const spaceId = options.currentSpaceId();
    if (!sessionId || !spaceId) return;

    await fetchStreamingCompletion({
      url: "/api/v1/chat/acp",
      sessionId,
      spaceId,
      documentId: options.documentId() || undefined,
      userMessage,
      imageAttachments,
      attachments,
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

  async function completeResponse(
    userMessage: string,
    additionalContext = "",
    imageAttachments: ImageChatAttachment[] = [],
    attachments: ChatAttachment[] = [],
  ) {
    if (options.isGenerating() || !options.currentSessionId()) return;
    options.setIsGenerating(true);
    abortController = new AbortController();
    const responseStartIndex = options.messages().length;

    try {
      await streamAssistantResponse(
        userMessage,
        responseStartIndex,
        additionalContext,
        imageAttachments,
        attachments,
      );
      await options.refreshCurrentSession();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const errorMessage =
          error instanceof Error ? error.message : "AI generation failed";
        pushMessage({
          role: "assistant",
          content: `Sorry, I encountered an error: ${errorMessage}`,
          timestamp: Date.now(),
        });
      }
    } finally {
      clearTransientStatusMessages(responseStartIndex);
      removeThinkingMessages(responseStartIndex);
      abortController = null;
      options.setIsGenerating(false);
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
    const sessionId = options.currentSessionId();
    const spaceId = options.currentSpaceId();
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
