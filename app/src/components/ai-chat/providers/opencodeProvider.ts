import type { AIChatAppProvider, ProviderConfig, ProviderContext } from "../types.ts";

async function fetchAcpCompletion(
  history: ProviderContext["history"],
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch("/api/v1/chat/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: history.map((message) => {
        if (
          message.role !== "system" &&
          message.role !== "user" &&
          message.role !== "assistant"
        ) {
          throw new Error(`Unsupported ACP history role: ${message.role}`);
        }
        if (typeof message.content !== "string") {
          throw new Error("ACP mode only supports text chat history");
        }
        return {
          role: message.role,
          content: message.content,
        };
      }),
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("ACP endpoint returned no assistant content");
  }
  return content;
}

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
    const content = await fetchAcpCompletion(context.history, context.signal);
    context.setAssistantContent(context.assistantMessageIndex, "");
    context.appendAssistantText(context.assistantMessageIndex, content);
    context.pushConversationMessage({ role: "assistant", content });
  },
};
