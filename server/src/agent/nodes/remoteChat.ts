import { parseAcpUpdate } from "#agent/acpUpdates.ts";
import type { AgentEvent, AgentResult } from "#agent/core.ts";
import { nodeRegistry } from "./registry.ts";

/**
 * Runs a chat's turn on its node. The node's session holds the conversation,
 * so the prompt carries only the new message.
 */
export async function runChatOnNode(options: {
  spaceId: string;
  userId: string;
  chatId: string;
  node: string;
  jobToken: string;
  text: string;
  /** Whether the chat had earlier turns, which a fresh session does not remember. */
  resumed: boolean;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<AgentResult> {
  const { node, signal, onEvent } = options;
  const toolNames = new Map<string, string>();
  let content = "";
  const { fresh, result } = nodeRegistry.promptChat({
    ...options,
    onUpdate(update) {
      const event = parseAcpUpdate(update, toolNames);
      if (!event) return;
      if (event.type === "text") content += event.text;
      onEvent(event);
    },
    onScreen: (taskId) => onEvent({ type: "screen", taskId, node, task: options.text }),
  });
  if (fresh && options.resumed) {
    onEvent({
      type: "status",
      text: `Started a new session on ${node}; it does not remember earlier messages.`,
    });
  }

  const cancel = () => nodeRegistry.cancelChat(options);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const { stopReason, error } = await result;
    if (stopReason === "cancelled") throw new DOMException("Cancelled", "AbortError");
    if (stopReason === "error") throw new Error(error ?? "The remote agent failed.");
    return { content, stopReason, messages: [{ role: "assistant", content }] };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
