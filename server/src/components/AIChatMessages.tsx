import {
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import type { AIChatMessage } from "#api/client.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import { formatTime } from "#utils/dateFormat.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { formatFileSize } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";

export interface AIChatMessagesHandle {
  scrollToBottom: () => void;
  scrollToBottomIfFollowing: () => void;
  scrollThinkingToBottom: () => void;
}

interface Props {
  messages: AIChatMessage[];
  isGenerating: boolean;
  sessionStartedAt: number | null;
  ref?: (handle: AIChatMessagesHandle) => void;
}

function attachmentPreviewUrl(attachment: { url: string }): string {
  return withTransformParams(attachment.url, { w: 640, format: "webp" });
}

function formatSessionStartTime(timestamp: number | null, lang: string): string {
  return timestamp === null ? "" : formatTime(timestamp, lang);
}

/**
 * Turning an agent tool call or its result into the one-line preview the chat
 * shows before you expand it. Pure and framework-free on purpose: each takes the
 * message (and the conversation, where a result has to be traced back to its
 * call) and returns a string, so none of them read reactive state.
 */

function parseToolArguments(content: string): Record<string, unknown> | null {
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

function parseToolResultContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function getBashCommandFromToolCallMessage(message: AIChatMessage): string | null {
  if (message.toolName !== "bash" || message.toolPhase !== "call") {
    return null;
  }
  const args = parseToolArguments(message.content);
  const command = args?.command;
  return typeof command === "string" && command.trim() ? command : null;
}

function findBashCommandForResultMessage(
  message: AIChatMessage,
  messages: readonly AIChatMessage[],
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

function formatBashResultPreview(
  message: AIChatMessage,
  result: unknown,
  messages: readonly AIChatMessage[],
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

function formatValuePreview(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function summarizeDocumentLikeResult(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const title =
    typeof properties?.title === "string"
      ? properties.title
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

function summarizeCollectionResult(value: unknown): string | null {
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

function formatToolPreview(
  message: AIChatMessage,
  messages: readonly AIChatMessage[],
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

function formatCollapsedToolInput(
  message: AIChatMessage,
  messages: readonly AIChatMessage[],
): string {
  if (message.toolPhase !== "call") return "";
  const preview = formatToolPreview(message, messages).replace(/\s+/g, " ").trim();
  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
}

function getToolMessageKey(message: AIChatMessage, index: number): string {
  return message.toolCallId
    ? `${message.toolCallId}:${message.toolPhase ?? "unknown"}`
    : `tool:${index}:${message.timestamp}`;
}

type ToolRun = {
  key: string;
  items: Array<{ message: AIChatMessage; key: string }>;
};

/** Maps each shown tool message to the run of consecutive tool messages it belongs to. */
function groupToolRuns(messages: readonly AIChatMessage[]): Map<AIChatMessage, ToolRun> {
  const runs = new Map<AIChatMessage, ToolRun>();
  let run: ToolRun | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "tool") {
      run = null;
      continue;
    }
    if (message.toolPhase === "call") continue;
    const key = getToolMessageKey(message, index);
    run ??= { key: `run:${key}`, items: [] };
    run.items.push({ message, key });
    runs.set(message, run);
  }
  return runs;
}

/** Tool names in first-use order with repeat counts, e.g. `bash, search_documents ×14`. */
function summarizeToolRun(run: ToolRun): string {
  const counts = new Map<string, number>();
  for (const { message } of run.items) {
    const name = message.toolName || "Tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

export function AIChatMessages(props: Props) {
  const lang = useLocale();
  let messagesContainer: HTMLDivElement | undefined;
  const [shouldFollowMessages, setShouldFollowMessages] = createSignal(true);
  const [expandedToolMessages, setExpandedToolMessages] = createSignal(new Set<string>());
  const [copiedAssistantMessageTimestamp, setCopiedAssistantMessageTimestamp] =
    createSignal<number | null>(null);

  let scrollAnimationFrame: number | null = null;
  let clearCopiedAssistantMessageTimer: ReturnType<typeof setTimeout> | null = null;

  const waitingState = createMemo(
    (): { kind: "tool_executing"; tool: AIChatMessage } | { kind: "waiting" } | null => {
      if (!props.isGenerating) return null;
      const last = props.messages.at(-1);
      if (last?.role === "tool" && last.toolPhase === "call") {
        return { kind: "tool_executing", tool: last };
      }
      if (
        last?.role === "assistant" ||
        last?.role === "thinking" ||
        last?.role === "status"
      ) {
        return null;
      }
      return { kind: "waiting" };
    },
  );

  const toolRuns = createMemo(() => groupToolRuns(props.messages));

  /** Only a run's first message renders; it draws the whole run. */
  function isMessageShown(message: AIChatMessage): boolean {
    if (message.role !== "tool") return true;
    return toolRuns().get(message)?.items[0]?.message === message;
  }

  function toolPreview(message: AIChatMessage): string {
    return formatToolPreview(message, props.messages);
  }

  function collapsedToolInput(message: AIChatMessage): string {
    return formatCollapsedToolInput(message, props.messages);
  }

  function isToolMessageExpanded(key: string): boolean {
    return expandedToolMessages().has(key);
  }

  function toggleToolMessageExpanded(key: string) {
    const next = new Set(expandedToolMessages());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedToolMessages(next);
  }

  function renderToolHeader(
    key: string,
    label: string,
    name: string,
    detail: string,
    isError: boolean,
  ) {
    return (
      <button
        type="button"
        class="flex min-w-0 max-w-full items-center gap-1.5 py-0.5 pointer-coarse:py-2 text-left text-size-small transition-colors"
        classList={{
          "text-red-600 hover:text-red-700": isError,
          "text-neutral-500 hover:text-neutral-800": !isError,
        }}
        onClick={() => toggleToolMessageExpanded(key)}
      >
        <Icon
          class={`h-3.5 w-3.5 shrink-0 transition-transform ${isToolMessageExpanded(key) ? "rotate-90" : ""}`}
          name="chevron-right-small"
        />
        <span class="shrink-0">{label}</span>
        <span class="truncate font-medium">{name}</span>
        <Show when={detail}>
          <span class="min-w-0 flex-1 truncate text-neutral-400">{detail}</span>
        </Show>
      </button>
    );
  }

  function renderToolMessage(message: AIChatMessage, key: string) {
    return (
      <div class="min-w-0">
        {renderToolHeader(
          key,
          "Used",
          message.toolName || "Tool",
          collapsedToolInput(message),
          Boolean(message.isError),
        )}
        <Show when={isToolMessageExpanded(key)}>
          <pre
            class="mt-1 mb-2 ml-5 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border px-3 py-2 font-mono text-size-extra-small leading-relaxed"
            classList={{
              "border-red-500/30 bg-red-500/5 text-red-600": message.isError,
              "border-neutral-200 bg-neutral-50 text-neutral-700": !message.isError,
            }}
          >
            {toolPreview(message)}
          </pre>
        </Show>
      </div>
    );
  }

  function renderToolRun(run: () => ToolRun) {
    const failed = () => run().items.filter(({ message }) => message.isError).length;
    return (
      <Show
        when={run().items.length > 1}
        fallback={renderToolMessage(run().items[0].message, run().items[0].key)}
      >
        <div class="min-w-0 flex-1">
          {renderToolHeader(
            run().key,
            `Used ${run().items.length} tools`,
            summarizeToolRun(run()),
            failed() ? `· ${failed()} failed` : "",
            false,
          )}
          <Show when={isToolMessageExpanded(run().key)}>
            <div class="mt-1 ml-[7px] border-neutral-200 border-l pl-3">
              <Index each={run().items}>
                {(item) => renderToolMessage(item().message, item().key)}
              </Index>
            </div>
          </Show>
        </div>
      </Show>
    );
  }

  async function copyAssistantMessage(message: AIChatMessage) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
        copied = true;
      }
    } catch {}

    if (!copied) {
      const textarea = document.createElement("textarea");
      textarea.value = message.content;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      textarea.remove();
    }

    if (!copied) return;
    setCopiedAssistantMessageTimestamp(message.timestamp);
    if (clearCopiedAssistantMessageTimer !== null) {
      clearTimeout(clearCopiedAssistantMessageTimer);
    }
    clearCopiedAssistantMessageTimer = setTimeout(() => {
      setCopiedAssistantMessageTimestamp(null);
      clearCopiedAssistantMessageTimer = null;
    }, 2000);
  }

  function isNearBottom(): boolean {
    if (!messagesContainer) return true;
    return (
      messagesContainer.scrollHeight -
        messagesContainer.scrollTop -
        messagesContainer.clientHeight <
      80
    );
  }

  function onMessagesScroll() {
    setShouldFollowMessages(isNearBottom());
  }

  function scheduleScrollToBottom() {
    if (!shouldFollowMessages() || scrollAnimationFrame !== null) return;
    scrollAnimationFrame = requestAnimationFrame(() => {
      scrollAnimationFrame = null;
      if (!shouldFollowMessages() || !messagesContainer) return;
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  function scrollToBottom() {
    setShouldFollowMessages(true);
    scheduleScrollToBottom();
  }

  function scrollToBottomIfFollowing() {
    scheduleScrollToBottom();
  }

  function scrollThinkingToBottom() {
    requestAnimationFrame(() => {
      if (!messagesContainer) return;
      const pres = messagesContainer.querySelectorAll(".thinking-content");
      if (!pres.length) return;
      const lastPre = pres[pres.length - 1] as HTMLElement;
      lastPre.scrollTop = lastPre.scrollHeight;
      scrollToBottomIfFollowing();
    });
  }

  onCleanup(() => {
    if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
    if (clearCopiedAssistantMessageTimer !== null) {
      clearTimeout(clearCopiedAssistantMessageTimer);
    }
  });

  props.ref?.({ scrollToBottom, scrollToBottomIfFollowing, scrollThinkingToBottom });

  const TypingDots = (): JSX.Element => (
    <>
      <span class="typing-dot" />
      <span class="typing-dot" style={{ "animation-delay": "160ms" }} />
      <span class="typing-dot" style={{ "animation-delay": "320ms" }} />
    </>
  );

  return (
    <div
      ref={messagesContainer}
      class="messages-container flex-1 space-y-4 overflow-y-auto px-4 py-4"
      onScroll={onMessagesScroll}
    >
      <Show when={props.messages.length === 0 && !props.isGenerating}>
        <div class="flex h-full flex-col items-center justify-center gap-3 text-center">
          <div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/10">
            <Icon class="h-5 w-5 text-primary-600" name="agent-chat" />
          </div>
          <div>
            <p class="font-medium text-neutral-800 text-size-medium">How can I help?</p>
            <p class="mt-1 text-neutral-500 text-size-small">
              Ask about this document, or @mention others.
            </p>
          </div>
        </div>
      </Show>
      <Show when={props.sessionStartedAt}>
        <div class="text-center text-neutral-400 text-size-extra-small">
          {formatSessionStartTime(props.sessionStartedAt, lang)}
        </div>
      </Show>
      <For each={props.messages}>
        {(message) => (
          <Show when={isMessageShown(message)}>
            <div
              class="flex animate-message-slide-in"
              classList={{
                "justify-center": message.role === "system",
                "justify-end": message.role === "user",
              }}
            >
              <Show when={message.role === "system"}>
                <div class="rounded-full bg-neutral-100 px-3 py-1 text-neutral-600 text-size-small">
                  {message.content}
                </div>
              </Show>

              <Show when={message.role === "status"}>
                <div class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                  <div class="mb-1 font-medium text-neutral-500 text-size-extra-small">
                    Agent log
                  </div>
                  <pre class="whitespace-pre-wrap font-mono text-neutral-700 text-size-extra-small leading-relaxed">
                    {message.content}
                  </pre>
                </div>
              </Show>

              <Show when={message.role === "thinking"}>
                <div class="min-w-0 flex-1 border-neutral-200 border-l-2 pl-3">
                  <div class="mb-1 flex items-center gap-1.5 font-medium text-neutral-500 text-size-small">
                    <Icon class="h-3.5 w-3.5" name="thinking" />
                    Thinking
                  </div>
                  <pre class="thinking-content max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-neutral-500 text-size-small leading-relaxed">
                    {message.content}
                  </pre>
                </div>
              </Show>

              <Show when={message.role === "assistant"}>
                <div class="group min-w-0 flex-1">
                  <div
                    class="markdown-content text-neutral-800 text-size-medium leading-relaxed"
                    innerHTML={renderMessageMarkdown(message.content)}
                  />
                  <div class="mt-1 -ml-1.5 flex items-center gap-1 text-neutral-400 text-size-extra-small transition-opacity pointer-fine:opacity-0 pointer-fine:focus-within:opacity-100 pointer-fine:group-hover:opacity-100">
                    <IconButton
                      class="h-6 w-6 pointer-coarse:h-9 pointer-coarse:w-9 [&_.svg-icon]:h-3.5 [&_.svg-icon]:w-3.5"
                      icon={
                        copiedAssistantMessageTimestamp() === message.timestamp
                          ? "confirmation"
                          : "copy"
                      }
                      label={
                        copiedAssistantMessageTimestamp() === message.timestamp
                          ? "Copied!"
                          : "Copy"
                      }
                      onClick={() => void copyAssistantMessage(message)}
                    />
                    {formatTime(message.timestamp, lang)}
                  </div>
                </div>
              </Show>

              <Show when={message.role === "tool" && toolRuns().get(message)}>
                {(run) => renderToolRun(run)}
              </Show>

              <Show when={message.role === "user"}>
                <div class="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-100 px-3.5 py-2 text-neutral-800">
                  <div
                    class="markdown-content text-size-medium leading-relaxed"
                    innerHTML={renderMessageMarkdown(message.content)}
                  />
                  <Show when={message.attachments?.length}>
                    <div class="mt-2 mb-1 space-y-1.5">
                      <For each={message.attachments}>
                        {(attachment) => (
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="block overflow-hidden rounded-lg border border-neutral-200 bg-neutral-10 text-size-small transition-colors hover:bg-neutral-50"
                          >
                            <Show when={attachment.isImage}>
                              <img
                                src={attachmentPreviewUrl(attachment)}
                                alt={attachment.name}
                                class="block max-h-80 w-full bg-neutral-50 object-contain"
                                decoding="async"
                                loading="lazy"
                              />
                            </Show>
                            <span class="block px-2 py-1.5">
                              <span class="font-medium">{attachment.name}</span>
                              <span class="ml-1 text-neutral-500">
                                {formatFileSize(attachment.size)}
                              </span>
                            </span>
                          </a>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        )}
      </For>

      <Show when={waitingState()?.kind === "tool_executing"}>
        {(_) => {
          const state = waitingState();
          if (state?.kind !== "tool_executing") return null;
          return (
            <div class="flex min-w-0 animate-message-slide-in items-center gap-1.5 text-neutral-500 text-size-small">
              <Icon class="h-3.5 w-3.5 shrink-0 animate-spin" name="spinner" />
              <span class="shrink-0">Running</span>
              <span class="truncate font-medium">{state.tool.toolName}</span>
              <Show when={collapsedToolInput(state.tool)}>
                <span class="min-w-0 truncate text-neutral-400">
                  {collapsedToolInput(state.tool)}
                </span>
              </Show>
            </div>
          );
        }}
      </Show>

      <Show when={waitingState()?.kind === "waiting"}>
        <div class="flex h-6 animate-message-slide-in items-center gap-1 px-0.5">
          <TypingDots />
        </div>
      </Show>
    </div>
  );
}
