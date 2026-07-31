import type { UIMessage } from "#composeables/useChatSessions.ts";

/**
 * Turning an agent tool call or its result into the one-line preview the chat
 * shows before you expand it.
 *
 * Pure and framework-free: every function here takes the message (and, where a
 * result has to be traced back to its call, the conversation) and returns a
 * string. Nothing reads reactive state.
 */

export function parseToolArguments(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseToolResultContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

export function getBashCommandFromToolCallMessage(message: UIMessage): string | null {
  if (message.toolName !== "bash" || message.toolPhase !== "call") {
    return null;
  }
  const args = parseToolArguments(message.content);
  const command = args?.command;
  return typeof command === "string" && command.trim() ? command : null;
}

export function findBashCommandForResultMessage(
  message: UIMessage,
  messages: readonly UIMessage[],
): string | null {
  if (message.toolName !== "bash" || message.toolPhase !== "result") {
    return null;
  }
  const toolCallId = message.toolCallId;
  if (!toolCallId) {
    return null;
  }
  const toolCallMessage = messages.find(
    (candidate) =>
      candidate.toolCallId === toolCallId &&
      candidate.toolName === "bash" &&
      candidate.toolPhase === "call",
  );
  return toolCallMessage ? getBashCommandFromToolCallMessage(toolCallMessage) : null;
}

export function formatBashResultPreview(
  message: UIMessage,
  result: unknown,
  messages: readonly UIMessage[],
): string {
  const output =
    typeof result === "string"
      ? result.trim() || "(no output)"
      : formatValuePreview(result);
  const command = findBashCommandForResultMessage(message, messages);
  if (!command) {
    return output;
  }
  return `$ ${command}\n\n${output}`;
}

export function formatValuePreview(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

export function summarizeDocumentLikeResult(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const title =
    typeof record.title === "string"
      ? record.title
      : typeof record.slug === "string"
        ? record.slug
        : null;
  const id = typeof record.id === "string" ? record.id : null;
  const type = typeof record.type === "string" ? record.type : null;
  const parts = [title, id ? `id: ${id}` : null, type ? `type: ${type}` : null].filter(
    Boolean,
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

export function summarizeCollectionResult(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["documents", "results", "items"]) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    const lines = items.slice(0, 5).map((item, index) => {
      const summary = summarizeDocumentLikeResult(item);
      return summary
        ? `${index + 1}. ${summary.replace(/\n/g, " · ")}`
        : `${index + 1}. ${formatValuePreview(item)}`;
    });
    const extra =
      items.length > lines.length ? `\n+${items.length - lines.length} more` : "";
    return lines.join("\n") + extra;
  }
  return null;
}

export function formatToolPreview(
  message: UIMessage,
  messages: readonly UIMessage[],
): string {
  if (message.toolPhase === "call") {
    const args = parseToolArguments(message.content);
    if (!args) {
      return message.content;
    }

    if (message.toolName === "bash") {
      const command = args.command;
      if (typeof command === "string" && command.trim()) {
        return command;
      }
    }

    const previewEntries = Object.entries(args)
      .filter(([, value]) => value !== undefined)
      .slice(0, 4)
      .map(([key, value]) => {
        if (typeof value === "string") {
          return `${key}: ${value}`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      });

    if (previewEntries.length === 0) {
      return message.toolName ? `${message.toolName}()` : message.content;
    }

    return previewEntries.join("\n");
  }

  const result = parseToolResultContent(message.content);

  if (message.toolName === "bash") {
    return formatBashResultPreview(message, result, messages);
  }

  if (
    message.toolName === "get_document" ||
    message.toolName === "get_current_document"
  ) {
    const summary = summarizeDocumentLikeResult(result);
    if (summary) {
      const record = result as Record<string, unknown>;
      const body =
        typeof record.content === "string"
          ? `\n\n${record.content.slice(0, 1200)}${record.content.length > 1200 ? "\n…" : ""}`
          : "";
      return summary + body;
    }
  }

  if (message.toolName === "list_documents" || message.toolName === "search_documents") {
    const summary = summarizeCollectionResult(result);
    if (summary) {
      return summary;
    }
  }

  if (message.toolName === "upload_artifact") {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const record = result as Record<string, unknown>;
      const parts = [
        typeof record.key === "string" ? `key: ${record.key}` : null,
        typeof record.url === "string" ? `url: ${record.url}` : null,
      ].filter(Boolean);
      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }

  if (typeof result === "string") {
    return result;
  }

  const collectionSummary = summarizeCollectionResult(result);
  if (collectionSummary) {
    return collectionSummary;
  }
  const itemSummary = summarizeDocumentLikeResult(result);
  if (itemSummary) {
    return itemSummary;
  }
  return formatValuePreview(result);
}

export function formatCollapsedToolInput(
  message: UIMessage,
  messages: readonly UIMessage[],
): string {
  if (message.toolPhase !== "call") return "";
  const preview = formatToolPreview(message, messages).replace(/\s+/g, " ").trim();
  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
}

export function getToolMessageKey(message: UIMessage, index: number): string {
  return message.toolCallId
    ? `${message.toolCallId}:${message.toolPhase ?? "unknown"}`
    : `tool:${index}:${message.timestamp}`;
}

export function getMessageKey(message: UIMessage, index: number): string {
  if (message.role === "tool") {
    return getToolMessageKey(message, index);
  }
  return `${message.role}:${message.timestamp}:${index}`;
}
