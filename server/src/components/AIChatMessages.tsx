import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { AIChatMessage } from "#api/client.ts";
import type { ChatAuthor } from "#composeables/useBotChannels.ts";
import type { RoleChange, RoleProposalStatus } from "#composeables/useChatSession.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { highlightStaticCodeBlocks } from "#editor/prism.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import { formatTime } from "#utils/dateFormat.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { formatFileSize } from "#utils/utils.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import "./AvatarElement.ts";

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
  /** Labels the start of each of the bot's answers. */
  bot?: { name: string; avatar: string | null };
  /** The thread replying to a message, by the message's seq. */
  threadOf?: (seq: number) => { messageCount?: number } | undefined;
  /** Opens a message's thread, starting it when there is none. */
  onOpenThread?: (seq: number) => void;
  /** Offers older messages above the first. */
  onLoadOlder?: () => void;
  /** Shows the bot's role proposals, and lets an editor apply them. */
  roleProposals?: RoleProposals;
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

  if (message.toolName === "search_documents") {
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

/** What a tool does, as a row's label: `search_documents` → "Search documents". */
function toolLabel(name: string | undefined): string {
  if (!name) return "Tool";
  if (name === "bash") return "Command";
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An icon for the kind of thing a tool does, read from its name. */
function toolIcon(name: string | undefined): IconName {
  if (!name) return "function";
  if (name === "bash") return "source-code";
  if (name.startsWith("search_") || name.startsWith("find_") || name === "web_search")
    return "search";
  if (/^(get|read|list)_/.test(name)) return "document";
  if (/^(create|update|edit|write|upload)_/.test(name)) return "edit-entry";
  if (/^(delete|remove)_/.test(name)) return "delete-entry";
  return "function";
}

/** Tool labels in first-use order with repeat counts, e.g. `Command ×2, Search documents`. */
function summarizeToolRun(run: ToolRun): string {
  const counts = new Map<string, number>();
  for (const { message } of run.items) {
    const name = toolLabel(message.toolName);
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

/**
 * Wraps each code block with its language and a copy button. Plain DOM: the
 * markup comes from `innerHTML`, so there is no component to hang them on.
 */
function decorateCodeBlocks(root: HTMLElement) {
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const language =
      [...(code?.classList ?? [])]
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length) ?? "";
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const bar = document.createElement("div");
    bar.className = "code-block-bar";
    const label = document.createElement("span");
    label.textContent = language;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(pre.textContent ?? "").then(() => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1500);
      });
    });
    bar.append(label, copy);
    pre.replaceWith(wrapper);
    wrapper.append(bar, pre);
  }
}

/**
 * A message's markdown, with its code blocks labelled, copyable and
 * highlighted. Re-rendered as a message streams in; a fence still open renders
 * as code until it closes.
 */
function MarkdownContent(props: { content: string; class?: string }) {
  let element: HTMLDivElement | undefined;
  createEffect(() => {
    const html = renderMessageMarkdown(props.content);
    if (!element) return;
    element.innerHTML = html;
    decorateCodeBlocks(element);
    void highlightStaticCodeBlocks(element);
  });
  return <div ref={element} class={`markdown-content ${props.class ?? ""}`} />;
}

/** How proposals to change the bot's role are shown and applied. */
export type RoleProposals = {
  /** What a proposal changes in the role it was made against. */
  changes: (proposal: RoleProposalData) => RoleChange[];
  status: (proposal: RoleProposalData) => RoleProposalStatus;
  /** Unset for a viewer who may not edit the bot. */
  apply?: (proposal: RoleProposalData) => Promise<void>;
};

type RoleProposalData = NonNullable<AIChatMessage["proposal"]>;

const PROPOSAL_STATUS = {
  pending: { label: "Pending", class: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  applied: { label: "Applied", class: "bg-green-500/15 text-green-700 dark:text-green-400" },
  outdated: { label: "Outdated", class: "bg-neutral-500/15 text-neutral-600" },
} as const;

/**
 * A bot's proposal to change its role: what changes, and applying it.
 * Once applied or outdated, the changes fold away behind "Show changes".
 */
function RoleProposal(props: {
  proposal: RoleProposalData;
  proposals: RoleProposals;
  /** Who applied it, by name. */
  nameOf: (authorId: string | null) => string;
}) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const [showChanges, setShowChanges] = createSignal(false);
  const lang = useLocale();
  const status = () => props.proposals.status(props.proposal);
  /** Applied or outdated: nothing left to decide. */
  const settled = () => status() !== "pending";

  async function apply(run: (proposal: RoleProposalData) => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await run(props.proposal);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not apply the change");
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="my-1.5 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-10 shadow-xs">
      <div class="flex items-start gap-3 p-3">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-primary-600">
          <Icon class="h-4 w-4" name="edit-entry" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-neutral-900 text-size-small">Role update</span>
            <span
              class={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[0.65rem] uppercase tracking-wide ${PROPOSAL_STATUS[status()].class}`}
            >
              <Show when={status() === "applied"}>
                <Icon class="h-3 w-3" name="confirmation" />
              </Show>
              {PROPOSAL_STATUS[status()].label}
            </span>
          </div>
          <Show when={props.proposal.applied}>
            {(applied) => (
              <p class="mt-1 text-neutral-500 text-size-extra-small">
                Applied by {props.nameOf(applied().by)} · {formatTime(applied().at, lang)}
              </p>
            )}
          </Show>
          <Show when={status() === "outdated"}>
            <p class="mt-1 text-neutral-500 text-size-extra-small">
              The role changed since this was proposed.
            </p>
          </Show>
        </div>
        <Show when={!settled()}>
          <Show
            when={props.proposals.apply}
            fallback={
              <span class="shrink-0 self-center text-neutral-500 text-size-extra-small">
                Waiting for an editor
              </span>
            }
          >
            {(run) => (
              <button
                type="button"
                disabled={pending()}
                class="shrink-0 self-center rounded-lg bg-primary-600 px-3 py-1.5 font-medium text-size-small text-white shadow-xs transition-colors hover:bg-primary-700 disabled:opacity-60"
                onClick={() => void apply(run())}
              >
                {pending() ? "Applying…" : "Apply"}
              </button>
            )}
          </Show>
        </Show>
      </div>

      <Show
        when={!settled() || showChanges()}
        fallback={
          <button
            type="button"
            class="flex w-full items-center gap-1 border-neutral-100 border-t px-3 py-2 text-neutral-500 text-size-extra-small transition-colors hover:bg-neutral-500/5 hover:text-neutral-800"
            onClick={() => setShowChanges(true)}
          >
            <Icon class="h-3 w-3" name="chevron-right-small" />
            Show changes
          </button>
        }
      >
        <div class="max-h-64 overflow-auto whitespace-pre-wrap border-neutral-100 border-t bg-neutral-50 px-4 py-3 text-neutral-700 text-size-small leading-relaxed">
          <For each={props.proposals.changes(props.proposal)}>
            {(part) => (
              <Show when={part.kind !== "same"} fallback={<span>{part.text}</span>}>
                <Show
                  when={part.kind === "add"}
                  fallback={
                    <del class="text-neutral-500 decoration-red-500/70 line-through">
                      {part.text}
                    </del>
                  }
                >
                  <ins class="rounded bg-green-500/15 px-0.5 text-green-700 no-underline dark:text-green-400">
                    {part.text}
                  </ins>
                </Show>
              </Show>
            )}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="border-neutral-100 border-t px-3 py-2 text-red-600 text-size-small">{error()}</p>
      </Show>
    </div>
  );
}

/** Fields shown before the rest fold behind "+N more". */
const VISIBLE_EVENT_FIELDS = 6;

/**
 * An event's payload as small labelled chips, the way properties read, and
 * whether it was read without a reply. Per message rather than in the group's
 * tag: one group can mix quiet and waking events.
 */
function EventFields(props: {
  fields: Array<{ label: string; value: string }>;
  quiet: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const shown = () =>
    expanded() ? props.fields : props.fields.slice(0, VISIBLE_EVENT_FIELDS);
  const hidden = () => props.fields.length - shown().length;
  return (
    <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-size-extra-small">
      <For each={shown()}>
        {(field) => (
          <span
            class="inline-flex max-w-full items-center gap-1 rounded-md bg-neutral-500/10 px-1.5 py-0.5"
            title={`${field.label}: ${field.value}`}
          >
            <span class="shrink-0 text-neutral-500">{field.label}</span>
            <span class="truncate font-medium text-neutral-800">{field.value}</span>
          </span>
        )}
      </For>
      <Show when={hidden() > 0}>
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-500/10 hover:text-neutral-800"
          onClick={() => setExpanded(true)}
        >
          +{hidden()} more
        </button>
      </Show>
      <Show when={props.quiet}>
        <span class="text-neutral-400">No reply needed</span>
      </Show>
    </div>
  );
}

/** Within this long, one author's messages share one header. */
const GROUP_GAP_MS = 7 * 60_000;

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
    if (author?.event) {
      return {
        name: author.name,
        avatar: (
          <span class="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
            <Icon class="h-5 w-5" name="bolt" />
          </span>
        ),
        tag: "Event",
      };
    }
    return {
      name: author?.name ?? "Someone",
      // The app's own avatar: the profile image, or the cosmetics the person wears.
      avatar: (
        <vektor-avatar
          size="40"
          attr:user-id={message.authorId ?? undefined}
          prop:user={author}
        />
      ),
    };
  }

  function renderUserContent(message: AIChatMessage) {
    return (
      <>
        <MarkdownContent content={message.content} class="text-size-medium leading-relaxed" />
        <Show when={message.eventFields?.length || message.quiet}>
          <EventFields fields={message.eventFields ?? []} quiet={!!message.quiet} />
        </Show>
        <Show when={message.attachments?.length}>
          <div class="mt-2 mb-1 space-y-1.5">
            <For each={message.attachments}>
              {(attachment) => (
                // A plain card, not one link: a player's controls inside a link would follow it.
                <div class="max-w-[28rem] overflow-hidden rounded-lg border border-neutral-200 bg-neutral-10 text-size-small">
                  <Show when={attachment.isImage}>
                    <a href={attachment.url} target="_blank" rel="noopener noreferrer">
                      <img
                        src={attachmentPreviewUrl(attachment)}
                        alt={attachment.name}
                        class="block max-h-80 w-full bg-neutral-50 object-contain"
                        decoding="async"
                        loading="lazy"
                      />
                    </a>
                  </Show>
                  <Show when={attachment.type.startsWith("video/")}>
                    {/* biome-ignore lint/a11y/useMediaCaption: a user's upload comes with no captions to offer. */}
                    <video
                      src={attachment.url}
                      controls
                      preload="metadata"
                      class="block max-h-80 w-full bg-black"
                    />
                  </Show>
                  <Show when={attachment.type.startsWith("audio/")}>
                    {/* biome-ignore lint/a11y/useMediaCaption: a user's upload comes with no captions to offer. */}
                    <audio src={attachment.url} controls preload="metadata" class="block w-full" />
                  </Show>
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="block px-2 py-1.5 transition-colors hover:bg-neutral-50"
                  >
                    <span class="font-medium">{attachment.name}</span>
                    <span class="ml-1 text-neutral-500">
                      {formatFileSize(attachment.size)}
                    </span>
                  </a>
                </div>
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
              <span class="-ml-2 block whitespace-nowrap pt-1 text-right text-[0.6rem] text-neutral-400 opacity-0 group-hover/message:opacity-100">
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

  const chevron = (open: boolean) => (
    <Icon
      class={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${open ? "rotate-90" : ""}`}
      name="chevron-right-small"
    />
  );

  /** A tool's output, with a `$ command` line muted and stderr lines red. */
  function renderToolOutput(message: AIChatMessage) {
    return (
      <pre class="max-h-80 overflow-auto whitespace-pre-wrap border-neutral-200 border-t bg-neutral-50 px-3 py-2 font-mono text-neutral-700 text-size-extra-small leading-relaxed">
        <For each={toolPreview(message).split("\n")}>
          {(line) => (
            <div
              classList={{
                "text-neutral-400": line.startsWith("$ "),
                "text-red-600": line.startsWith("stderr:"),
              }}
            >
              {line || " "}
            </div>
          )}
        </For>
      </pre>
    );
  }

  /** One tool call as a row: what it did, its key input, and how it ended. */
  function renderToolRow(message: AIChatMessage, key: string) {
    const open = () => isToolMessageExpanded(key);
    return (
      <div class="min-w-0">
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-2 px-3 pointer-coarse:py-2.5 py-1.5 text-left text-size-small transition-colors hover:bg-neutral-500/5"
          onClick={() => toggleToolMessageExpanded(key)}
        >
          <Icon class="h-3.5 w-3.5 shrink-0 text-neutral-500" name={toolIcon(message.toolName)} />
          <span class="shrink-0 font-medium text-neutral-800">{toolLabel(message.toolName)}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-neutral-500 text-size-extra-small">
            {collapsedToolInput(message)}
          </span>
          <Icon
            class={`h-3.5 w-3.5 shrink-0 ${message.isError ? "text-red-600" : "text-green-600"}`}
            name={message.isError ? "cancel" : "confirmation"}
          />
          {chevron(open())}
        </button>
        <Show when={open()}>{renderToolOutput(message)}</Show>
      </div>
    );
  }

  /** A run of tool calls as one card; several fold behind a summary line. */
  function renderToolRun(run: () => ToolRun) {
    const failed = () => run().items.filter(({ message }) => message.isError).length;
    return (
      <div class="my-1 min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-10">
        <Show
          when={run().items.length > 1}
          fallback={renderToolRow(run().items[0].message, run().items[0].key)}
        >
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 px-3 pointer-coarse:py-2.5 py-1.5 text-left text-size-small transition-colors hover:bg-neutral-500/5"
            onClick={() => toggleToolMessageExpanded(run().key)}
          >
            <Icon class="h-3.5 w-3.5 shrink-0 text-neutral-500" name="function" />
            <span class="shrink-0 font-medium text-neutral-800">
              {run().items.length} tool calls
            </span>
            <span class="min-w-0 flex-1 truncate text-neutral-500">
              {summarizeToolRun(run())}
            </span>
            <Show when={failed()}>
              <span class="shrink-0 rounded-full bg-red-500/10 px-1.5 font-medium text-red-600 text-size-extra-small">
                {failed()} failed
              </span>
            </Show>
            {chevron(isToolMessageExpanded(run().key))}
          </button>
          <Show when={isToolMessageExpanded(run().key)}>
            <div class="divide-y divide-neutral-200 border-neutral-200 border-t">
              <Index each={run().items}>
                {(item) => renderToolRow(item().message, item().key)}
              </Index>
            </div>
          </Show>
        </Show>
      </div>
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

  /**
   * Set while the scroll event of our own scroll to the bottom is on its way.
   * That event can arrive after the content grew again (an image loading), and
   * must not read as the reader scrolling away.
   */
  let ownScroll = false;

  function onMessagesScroll() {
    if (ownScroll) {
      ownScroll = false;
      return;
    }
    setShouldFollowMessages(isNearBottom());
  }

  function scheduleScrollToBottom() {
    if (!shouldFollowMessages() || scrollAnimationFrame !== null) return;
    scrollAnimationFrame = requestAnimationFrame(() => {
      scrollAnimationFrame = null;
      if (!shouldFollowMessages() || !messagesContainer) return;
      const before = messagesContainer.scrollTop;
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      // No event fires for a scroll that went nowhere.
      ownScroll = messagesContainer.scrollTop !== before;
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

  // A picture or video that finishes loading grows the timeline without a
  // scroll event, which would leave a following reader above the bottom.
  // `load` does not bubble, so it is caught on the way down.
  onMount(() => {
    const follow = () => scrollToBottomIfFollowing();
    messagesContainer?.addEventListener("load", follow, true);
    messagesContainer?.addEventListener("loadedmetadata", follow, true);
    onCleanup(() => {
      messagesContainer?.removeEventListener("load", follow, true);
      messagesContainer?.removeEventListener("loadedmetadata", follow, true);
    });
  });

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
                  // Open while it streams in (no `seq` yet), folded away once logged.
                  <details
                    class="group/thinking my-1 border-neutral-200 border-l-2 pl-3"
                    open={message.seq === undefined}
                  >
                    <summary class="flex cursor-pointer list-none items-center gap-1.5 font-medium text-neutral-500 text-size-small hover:text-neutral-800">
                      <Icon class="h-3.5 w-3.5" name="thinking" />
                      Thinking
                      <Icon
                        class="h-3 w-3 transition-transform group-open/thinking:rotate-90"
                        name="chevron-right-small"
                      />
                    </summary>
                    <pre class="thinking-content mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-neutral-500 text-size-small leading-relaxed">
                      {message.content}
                    </pre>
                  </details>,
                  false,
                )}
              </Show>

              <Show when={message.role === "assistant"}>
                {renderRow(
                  message,
                  <MarkdownContent
                    content={message.content}
                    class={`text-size-medium leading-relaxed ${message.isError ? "text-red-600" : "text-neutral-800"}`}
                  />,
                  true,
                )}
              </Show>

              <Show
                when={
                  message.role === "proposal" && props.roleProposals && message.proposal
                    ? { proposal: message.proposal, proposals: props.roleProposals }
                    : undefined
                }
              >
                {(shown) =>
                  renderRow(
                    message,
                    <RoleProposal
                      proposal={shown().proposal}
                      proposals={shown().proposals}
                      nameOf={(id) => (id ? props.authorOf?.(id)?.name : undefined) ?? "Someone"}
                    />,
                    false,
                  )
                }
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
            <div class="pr-4 pl-18">
              <div class="my-1 flex min-w-0 animate-message-slide-in items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-10 px-3 py-1.5 text-size-small">
                <Icon
                  class="h-3.5 w-3.5 shrink-0 text-neutral-500"
                  name={toolIcon(state.tool.toolName)}
                />
                <span class="shrink-0 font-medium text-neutral-800">
                  {toolLabel(state.tool.toolName)}
                </span>
                <span class="min-w-0 flex-1 truncate font-mono text-neutral-500 text-size-extra-small">
                  {collapsedToolInput(state.tool)}
                </span>
                <Icon class="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" name="spinner" />
              </div>
            </div>
          );
        }}
      </Show>
      </div>
    </div>
  );
}
