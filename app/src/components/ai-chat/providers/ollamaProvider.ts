import { fetchStreamingCompletion } from "./shared.ts";
import type { AIChatAppProvider, ProviderConfig } from "../types.ts";

function getLabel(config: ProviderConfig) {
  return { name: config.ollamaModel || "Ollama", sub: "Local" };
}

export const ollamaProvider: AIChatAppProvider = {
  option: {
    value: "ollama",
    name: "Ollama",
    sub: "Local",
    configurable: true,
  },
  getLabel,
  buildSystemPrompt: (context) =>
    `${context.systemPrompt}\n\nIMPORTANT: Use native function tool calls via the API tool_calls field. Do not emit \`\`\`tool blocks.\n\nCurrent context:\n- spaceId: ${context.spaceId}\n- documentId: ${context.documentId}\n\n${context.currentDocumentSystemPrompt}`,
  send: async (context) => {
    const tools = await context.getOpenRouterTools();
    let completed = false;
    let currentAssistantIdx = context.assistantMessageIndex;

    for (let i = 0; i < context.maxAgentSteps; i++) {
      context.setAssistantContent(currentAssistantIdx, "");
      const { content, reasoning, toolCalls } = await fetchStreamingCompletion({
        url: `${context.config.ollamaBaseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        model: context.config.ollamaModel,
        history: context.history,
        onDelta: (text) => context.appendAssistantText(currentAssistantIdx, text),
        tools,
        signal: context.signal,
      });

      if (!toolCalls || toolCalls.length === 0) {
        context.setAssistantReasoning(currentAssistantIdx, reasoning);
        context.pushConversationMessage({ role: "assistant", content });
        completed = true;
        break;
      }

      context.setAssistantReasoning(currentAssistantIdx, reasoning);
      context.pushConversationMessage({
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const name = toolCall.function?.name || "unknown";
        let args: Record<string, unknown> = {};

        try {
          args = JSON.parse(toolCall.function?.arguments || "{}") as Record<
            string,
            unknown
          >;
        } catch {
          const error = `Invalid tool arguments for ${name}`;
          context.pushStatusMessage(`❌ Tool error: ${error}`);
          context.pushConversationMessage({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error }),
          });
          continue;
        }

        const allowed = await context.requestToolPermission(name, args);
        if (!allowed) {
          const denied = { error: `User denied permission for ${name}` };
          context.pushStatusMessage(`🛑 Tool denied: ${name}`);
          context.pushConversationMessage({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(denied),
          });
          continue;
        }

        try {
          const result = await context.executeToolCall(name, args);
          context.pushStatusMessage(`🔧 Tool result: ${name}`);
          context.pushConversationMessage({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (toolError) {
          const errorMsg =
            toolError instanceof Error ? toolError.message : "Tool execution failed";
          context.pushStatusMessage(`❌ Tool error: ${name} - ${errorMsg}`);
          context.pushConversationMessage({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: errorMsg }),
          });
        }
      }

      currentAssistantIdx = context.createAssistantPlaceholder();
    }

    if (!completed) {
      throw new Error(
        `Agent loop ended without a final response after ${context.maxAgentSteps} steps`,
      );
    }
  },
};
