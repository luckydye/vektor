export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  thinking?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

/**
 * ACP tool call kinds — used by clients to pick icons and display labels.
 * https://agentclientprotocol.com/protocol/v1/tool-calls
 */
export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

/**
 * Events delivered by the ACP streaming endpoint via `session/update`
 * notifications.  The names and shapes follow the Agent Client Protocol spec
 * (agentclientprotocol.com) wherever possible.
 */
export type ChatStreamEvent =
  /** Incremental text from the model (ACP: agent_message_chunk). */
  | { type: "text"; text: string }
  /** Incremental thinking/reasoning content (ACP: generic {type:"thinking"}). */
  | { type: "thinking"; text: string }
  /** Agent status / plan entry (ACP: plan). */
  | { type: "status"; text: string }
  /** Tool invocation started — status is "pending" then immediately "in_progress" (ACP: tool_call). */
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      toolArguments: string;
      kind: ToolCallKind;
    }
  /** Tool execution is actively running (ACP: tool_call_update status:"in_progress"). */
  | { type: "tool_progress"; toolCallId: string; toolName: string }
  /** Tool finished — carries the output (ACP: tool_call_update status:"completed"|"failed"). */
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
    };
