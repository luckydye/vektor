import { extractToolCalls, fetchStreamingCompletion, removeToolCalls } from "./shared.ts";
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
    `${context.systemPrompt}\n\nCurrent context:\n- spaceId: ${context.spaceId}\n- documentId: ${context.documentId}\n\n${context.currentDocumentSystemPrompt}`,
  send: async (context) => {
    let completed = false;

    for (let i = 0; i < context.maxAgentSteps; i++) {
      context.setAssistantContent(context.assistantMessageIndex, "");
      const { content, reasoning } = await fetchStreamingCompletion({
        url: `${context.config.ollamaBaseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        model: context.config.ollamaModel,
        history: context.history,
        onDelta: (text) => context.appendAssistantText(context.assistantMessageIndex, text),
        signal: context.signal,
      });

      const toolCalls = extractToolCalls(content);
      if (toolCalls.length > 0) {
        context.setAssistantContent(context.assistantMessageIndex, removeToolCalls(content));
        context.setAssistantReasoning(context.assistantMessageIndex, reasoning);
        context.pushConversationMessage({ role: "assistant", content });

        for (const toolCall of toolCalls) {
          const allowed = await context.requestToolPermission(toolCall.name, toolCall.args);
          if (!allowed) {
            context.pushStatusMessage(`🛑 Tool denied: ${toolCall.name}`);
            context.pushConversationMessage({
              role: "user",
              content: `[TOOL_ERROR]\nUser denied permission for ${toolCall.name}`,
            });
            continue;
          }

          try {
            const result = await context.executeToolCall(toolCall.name, toolCall.args);
            context.pushStatusMessage(`🔧 Tool result: ${toolCall.name}`);
            context.pushConversationMessage({
              role: "user",
              content: `[TOOL_RESULT]\n${JSON.stringify(result, null, 2)}\n\nNow answer the user's question using this data.`,
            });
          } catch (toolError) {
            const errorMsg =
              toolError instanceof Error ? toolError.message : "Tool execution failed";
            context.pushStatusMessage(`❌ Tool error: ${toolCall.name} - ${errorMsg}`);
            context.pushConversationMessage({
              role: "user",
              content: `[TOOL_ERROR]\n${errorMsg}`,
            });
          }
        }

        const followUpIdx = context.createAssistantPlaceholder();
        const followUp = await fetchStreamingCompletion({
          url: `${context.config.ollamaBaseUrl.replace(/\/$/, "")}/v1/chat/completions`,
          model: context.config.ollamaModel,
          history: context.history,
          onDelta: (text) => context.appendAssistantText(followUpIdx, text),
          signal: context.signal,
        });
        context.setAssistantReasoning(followUpIdx, followUp.reasoning);
        context.pushConversationMessage({ role: "assistant", content: followUp.content });
        completed = true;
        break;
      }

      context.setAssistantReasoning(context.assistantMessageIndex, reasoning);
      context.pushConversationMessage({ role: "assistant", content });
      completed = true;
      break;
    }

    if (!completed) {
      throw new Error(
        `Agent loop ended without a final response after ${context.maxAgentSteps} steps`,
      );
    }
  },
};
