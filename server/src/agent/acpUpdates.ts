import type { AgentEvent } from "#agent/core.ts";

type Update = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The text of a tool call's ACP content blocks; a diff shows as the file it edits. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: Update) => {
      if (block.type === "diff") return `Edited ${text(block.path)}`;
      return text((block.content as Update | undefined)?.text);
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Reads an ACP `session/update` as an agent event, or null for one with
 * nothing to show. Takes the Vektor server's own updates as well as standard
 * ACP agents'; `toolNames` carries each call's name to its result, which
 * standard updates do not repeat.
 */
export function parseAcpUpdate(
  update: Update,
  toolNames: Map<string, string>,
): AgentEvent | null {
  const kind = update.sessionUpdate;
  const content = update.content as Update | undefined;

  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    if (content?.type !== "text" || typeof content.text !== "string") return null;
    return {
      type: kind === "agent_message_chunk" ? "text" : "thinking",
      text: content.text,
    };
  }

  if (kind === "generic") {
    const generic = update.generic as Update | undefined;
    if (generic?.type === "thinking")
      return { type: "thinking", text: text(generic.text) };
    if (generic?.type === "screen") {
      return {
        type: "screen",
        sessionId: text(generic.sessionId),
        runner: text(generic.runner),
        task: text(generic.task),
      };
    }
    return null;
  }

  if (kind === "plan") {
    const first = (update.entries as Update[] | undefined)?.[0];
    return typeof first?.content === "string"
      ? { type: "status", text: first.content }
      : null;
  }

  const toolCallId = text(update.toolCallId);
  if (kind === "tool_call") {
    const toolName = text(update.title);
    toolNames.set(toolCallId, toolName);
    const input = update.input ?? update.rawInput;
    return {
      type: "tool_call",
      toolCallId,
      toolName,
      toolArguments: input === undefined || input === null ? "{}" : JSON.stringify(input),
    };
  }

  if (
    kind === "tool_call_update" &&
    (update.status === "completed" || update.status === "failed")
  ) {
    return {
      type: "tool_result",
      toolCallId,
      toolName: text(update.toolName) || toolNames.get(toolCallId) || "",
      content: contentText(update.content),
      isError: update.status === "failed",
    };
  }

  return null;
}
