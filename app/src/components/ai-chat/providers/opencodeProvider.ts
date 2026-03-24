import { fetchStreamingCompletion } from "./shared.ts";
import type { AIChatAppProvider, ProviderConfig } from "../types.ts";

function getLabel(_config: ProviderConfig) {
  return { name: "OpenCode", sub: "ACP" };
}

export const opencodeProvider: AIChatAppProvider = {
  option: {
    value: "opencode",
    name: "OpenCode",
    sub: "ACP",
  },
  getLabel,
  buildSystemPrompt: (context) =>
    `${context.systemPrompt}\n\nCurrent context:\n- spaceId: ${context.spaceId}\n- documentId: ${context.documentId}\n\n${context.currentDocumentSystemPrompt}`,
  send: async (context) => {
    context.setAssistantContent(context.assistantMessageIndex, "");

    const { content } = await fetchStreamingCompletion({
      url: "/api/v1/chat/acp",
      model: "acp-configured-agent",
      history: context.history,
      onDelta: (text) => context.appendAssistantText(context.assistantMessageIndex, text),
      signal: context.signal,
    });

    context.pushConversationMessage({ role: "assistant", content });
  },
};
