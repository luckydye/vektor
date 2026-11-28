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
import type { ChatAuthor } from "#composeables/useBotChannels.ts";
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
  /** Shown while there are no messages. */
  emptyTitle: string;
  emptyHint: string;
  /** Who posted a user message, by id. */
  authorOf?: (authorId: string) => ChatAuthor | undefined;
  /** The viewer: their own posts sit on the right, everyone else's on the left. */
  currentUserId?: string | null;
  /** Labels the start of each of the bot's answers. */
  bot?: { name: string; avatar: string | null };
  /** The thread replying to a message, by the message's seq. */
  threadOf?: (seq: number) => { messageCount?: number } | undefined;
  /** Opens a message's thread, starting it when there is none. */
  onOpenThread?: (seq: number) => void;
  /** Offers older messages above the first. */
  onLoadOlder?: () => void;
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

/**
 * A bot's avatar: an emoji or a few letters, else the agent icon. `class` sets
 * its size and shape.
 */
export function BotAvatar(props: { avatar: string | null; class?: string }) {
  return (
    <span
      class={`flex shrink-0 items-center justify-center bg-primary-500/10 text-primary-700 ${props.class ?? "h-5 w-5 rounded-md text-size-small"}`}
    >
      <Show when={props.avatar} fallback={<Icon class="h-3.5 w-3.5" name="agent-chat" />}>
        {props.avatar}
      </Show>
    </span>
  );
}

/** Within this long, one author's messages share one header. */
const GROUP_GAP_MS = 7 * 60_000;

function PersonAvatar(props: { name: string; image?: string | null }) {
  return (
    <Show
      when={props.image}
      fallback={
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-200 font-medium text-neutral-600 text-size-medium">
          {props.name.slice(0, 1).toUpperCase()}
        </span>
      }
    >
      {(image) => <img src={image()} alt="" class="h-10 w-10 shrink-0 rounded-full object-cover" />}
    </Show>
  );
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

  /**
   * The messages that open a group and so carry the author's avatar and name,
   * as in Discord: a run by one author, broken by a pause of several minutes.
   */
  const groupStarts = createMemo(() => {
    const starts = new Set<AIChatMessage>();
    let author: string | null = null;
    let last = 0;
    for (const message of props.messages) {
      if (!isMessageShown(message)) continue;
      const key =
        message.role === "user"
          ? `user:${message.authorId ?? ""}`
          : message.role === "system" || message.role === "screen"
            ? null
            : "bot";
      if (key !== author || message.timestamp - last > GROUP_GAP_MS) starts.add(message);
      author = key;
      last = message.timestamp;
    }
    return starts;
  });

  /** Who a message is from, as its group header shows them, and the tag beside the name. */
  function senderOf(message: AIChatMessage): {
    name: string;
    avatar: JSX.Element;
    tag?: string;
  } {
    const botAvatar = (avatar: string | null) => (
      <BotAvatar avatar={avatar} class="h-10 w-10 rounded-full text-size-large" />
    );
    if (message.role !== "user") {
      const bot = props.bot ?? { name: "Assistant", avatar: null };
      return { name: bot.name, avatar: botAvatar(bot.avatar), tag: "Bot" };
    }
    const author = message.authorId ? props.authorOf?.(message.authorId) : undefined;
    if (author?.bot) {
      return { name: author.name, avatar: botAvatar(author.bot.avatar), tag: "Scheduled" };
    }
    const name =
      author?.name ?? (message.authorId === props.currentUserId ? "You" : "Someone");
    return { name, avatar: <PersonAvatar name={name} image={author?.image} /> };
  }

  function renderUserContent(message: AIChatMessage) {
    return (
      <>
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
      </>
    );
  }

  /** The box under a thread's root message, as Discord shows a thread. */
  function renderThreadChip(message: AIChatMessage) {
    const seq = message.seq;
    const open = props.onOpenThread;
    const thread = seq === undefined ? undefined : props.threadOf?.(seq);
    // A thread opened but never replied to is not worth a box yet.
    if (seq === undefined || !open || !thread?.messageCount) return null;
    return (
      <button
        type="button"
        class="mt-1 flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-size-small transition-colors hover:border-neutral-300 hover:bg-neutral-100"
        onClick={() => open(seq)}
      >
        <Icon class="h-3.5 w-3.5 text-neutral-500" name="comment" />
        <span class="font-medium text-primary-700">
          {thread.messageCount === 1 ? "1 reply" : `${thread.messageCount ?? 0} replies`}
        </span>
        <Icon class="h-3 w-3 text-neutral-400" name="chevron-right-small" />
      </button>
    );
  }

  /** The actions floating over a hovered message's top-right corner. */
  function renderToolbar(message: AIChatMessage) {
    const seq = message.seq;
    const open = props.onOpenThread;
    const copied = () => copiedAssistantMessageTimestamp() === message.timestamp;
    return (
      <div class="absolute top-1 right-2 z-10 flex items-center rounded-md bg-neutral-10 opacity-0 shadow-xs ring-1 ring-neutral-500/15 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 pointer-coarse:hidden">
        <IconButton
          class="h-7 w-7 text-neutral-500 [&_.svg-icon]:h-3.5 [&_.svg-icon]:w-3.5"
          icon={copied() ? "confirmation" : "copy"}
          label={copied() ? "Copied!" : "Copy text"}
          tooltipPos="top"
          onClick={() => void copyAssistantMessage(message)}
        />
        <Show when={seq !== undefined && open}>
          <IconButton
            class="h-7 w-7 text-neutral-500 [&_.svg-icon]:h-3.5 [&_.svg-icon]:w-3.5"
            icon="comment"
            label={props.threadOf?.(seq as number) ? "Open thread" : "Reply in thread"}
            tooltipPos="top"
            onClick={() => open?.(seq as number)}
          />
        </Show>
      </div>
    );
  }

  /**
   * One row of the timeline: the avatar and header at the start of a group,
   * otherwise the time in the gutter on hover.
   */
  function renderRow(message: AIChatMessage, body: JSX.Element, actions: boolean) {
    const start = () => groupStarts().has(message);
    const sender = () => senderOf(message);
    return (
      <div
        class="group/message relative mx-2 flex gap-4 rounded-lg px-2 py-0.5 transition-colors hover:bg-neutral-500/5"
        classList={{ "mt-4": start() }}
      >
        <div class="w-10 shrink-0">
          <Show
            when={start()}
            fallback={
              <span class="block pt-1 text-right text-[0.65rem] text-neutral-400 opacity-0 group-hover/message:opacity-100">
                {formatTime(message.timestamp, lang)}
              </span>
            }
          >
            <div class="pt-0.5">{sender().avatar}</div>
          </Show>
        </div>
        <div class="min-w-0 flex-1">
          <Show when={start()}>
            <div class="flex items-baseline gap-2">
              <span class="font-semibold text-neutral-900 text-size-medium">{sender().name}</span>
              <Show when={sender().tag}>
                <span class="rounded bg-primary-500/15 px-1 font-semibold text-[0.6rem] text-primary-700 uppercase">
                  {sender().tag}
                </span>
              </Show>
              <span class="text-neutral-400 text-size-extra-small">
                {formatTime(message.timestamp, lang)}
              </span>
            </div>
          </Show>
          {body}
          {renderThreadChip(message)}
        </div>
        <Show when={actions}>{renderToolbar(message)}</Show>
      </div>
    );
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
        class="flex min-w-0 max-w-full items-center gap-1.5 pointer-coarse:py-2 py-0.5 text-left text-size-small transition-colors"
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

  return (
    <div
      ref={messagesContainer}
      class="messages-container flex-1 overflow-y-auto"
      onScroll={onMessagesScroll}
    >
      {/* A readable column: lines spanning a wide screen are hard to follow. */}
      {/* min-h-full with the padding inside: h-full plus padding always overflows by the padding. */}
      <div class="mx-auto flex min-h-full w-full max-w-[56rem] flex-col pt-2 pb-4">
      <Show when={props.messages.length === 0 && !props.isGenerating}>
        <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/10">
            <Show
              when={props.bot?.avatar}
              fallback={<Icon class="h-5 w-5 text-primary-600" name="agent-chat" />}
            >
              <span class="text-size-large">{props.bot?.avatar}</span>
            </Show>
          </div>
          <div>
            <p class="font-medium text-neutral-800 text-size-medium">{props.emptyTitle}</p>
            <p class="mt-1 text-neutral-500 text-size-small">{props.emptyHint}</p>
          </div>
        </div>
      </Show>
      <Show when={props.onLoadOlder}>
        {(loadOlder) => (
          <div class="text-center">
            <button
              type="button"
              class="rounded-full px-3 py-1 text-neutral-500 text-size-small hover:bg-neutral-100"
              onClick={() => loadOlder()()}
            >
              Show earlier messages
            </button>
          </div>
        )}
      </Show>
      <Show when={props.sessionStartedAt}>
        <div class="text-center text-neutral-400 text-size-extra-small">
          {formatSessionStartTime(props.sessionStartedAt, lang)}
        </div>
      </Show>
      <For each={props.messages}>
        {(message) => (
          <Show when={isMessageShown(message)}>
            <div class="animate-message-slide-in">
              <Show when={message.role === "system"}>
                <div class="my-2 text-center text-neutral-500 text-size-small">
                  {message.content}
                </div>
              </Show>

              <Show when={message.role === "status"}>
                {renderRow(
                  message,
                  <div class="my-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
                    <div class="mb-1 font-medium text-neutral-500 text-size-extra-small">
                      Agent log
                    </div>
                    <pre class="whitespace-pre-wrap font-mono text-neutral-700 text-size-extra-small leading-relaxed">
                      {message.content}
                    </pre>
                  </div>,
                  false,
                )}
              </Show>

              <Show when={message.role === "thinking"}>
                {renderRow(
                  message,
                  <div class="my-1 border-neutral-200 border-l-2 pl-3">
                    <div class="mb-1 flex items-center gap-1.5 font-medium text-neutral-500 text-size-small">
                      <Icon class="h-3.5 w-3.5" name="thinking" />
                      Thinking
                    </div>
                    <pre class="thinking-content max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-neutral-500 text-size-small leading-relaxed">
                      {message.content}
                    </pre>
                  </div>,
                  false,
                )}
              </Show>

              <Show when={message.role === "assistant"}>
                {renderRow(
                  message,
                  <div
                    class="markdown-content text-size-medium leading-relaxed"
                    classList={{
                      "text-neutral-800": !message.isError,
                      "text-red-600": message.isError,
                    }}
                    innerHTML={renderMessageMarkdown(message.content)}
                  />,
                  true,
                )}
              </Show>

              <Show when={message.role === "tool" && toolRuns().get(message)}>
                {(run) => renderRow(message, renderToolRun(run), false)}
              </Show>

              <Show when={message.role === "user"}>
                {renderRow(
                  message,
                  <div class="text-neutral-800">{renderUserContent(message)}</div>,
                  true,
                )}
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
            <div class="flex min-w-0 animate-message-slide-in items-center gap-1.5 py-1 pr-4 pl-18 text-neutral-500 text-size-small">
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
      </div>
    </div>
  );
}
