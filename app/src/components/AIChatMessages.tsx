import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import {
  agentChatIcon,
  confirmationIcon,
  copyIcon,
  linkIcon,
  thinkingIcon,
} from "#assets/icons.ts";
import type { UIMessage } from "#composeables/useChatSessions.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import {
  formatCollapsedToolInput,
  formatToolPreview,
  getToolMessageKey,
} from "#utils/aiToolPreview.ts";
import { formatTime } from "#utils/datetime.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { formatFileSize } from "#utils/utils.ts";

/**
 * Imperative handle, handed back through the `ref` prop.
 *
 * The panel drives scrolling — it knows when a send or a stream chunk happened —
 * but this component owns the scroll container, so it hands out the verbs.
 */
export interface AIChatMessagesHandle {
  scrollToBottom: () => void;
  scrollToBottomIfFollowing: () => void;
  scrollThinkingToBottom: () => void;
}

interface Props {
  messages: UIMessage[];
  isGenerating: boolean;
  sessionStartedAt: number | null;
  ref?: (handle: AIChatMessagesHandle) => void;
}

function attachmentPreviewUrl(attachment: { url: string }): string {
  return withTransformParams(attachment.url, { w: 640, format: "webp" });
}

function formatSessionStartTime(timestamp: number | null): string {
  return timestamp === null ? "" : formatTime(timestamp);
}

export function AIChatMessages(props: Props) {
  let messagesContainer: HTMLDivElement | undefined;
  const [shouldFollowMessages, setShouldFollowMessages] = createSignal(true);
  const [expandedToolMessages, setExpandedToolMessages] = createSignal(new Set<string>());
  const [copiedAssistantMessageTimestamp, setCopiedAssistantMessageTimestamp] =
    createSignal<number | null>(null);

  let scrollAnimationFrame: number | null = null;
  let clearCopiedAssistantMessageTimer: ReturnType<typeof setTimeout> | null = null;

  const waitingState = createMemo(
    (): { kind: "tool_executing"; tool: UIMessage } | { kind: "waiting" } | null => {
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

  /** Bound to the live conversation: a tool result names its call by id only. */
  function toolPreview(message: UIMessage): string {
    return formatToolPreview(message, props.messages);
  }

  function collapsedToolInput(message: UIMessage): string {
    return formatCollapsedToolInput(message, props.messages);
  }

  function isToolMessageExpanded(message: UIMessage, index: number): boolean {
    return expandedToolMessages().has(getToolMessageKey(message, index));
  }

  function toggleToolMessageExpanded(message: UIMessage, index: number) {
    const key = getToolMessageKey(message, index);
    const next = new Set(expandedToolMessages());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedToolMessages(next);
  }

  async function copyAssistantMessage(message: UIMessage) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
        copied = true;
      }
    } catch {
      // Some embedded or non-secure contexts deny the Clipboard API. Fall back
      // to the synchronous browser copy command below.
    }

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
    // Solid has already applied the message write by the time a caller reaches
    // here, so the frame below measures the new content — no tick to await.
    if (!shouldFollowMessages() || scrollAnimationFrame !== null) return;
    scrollAnimationFrame = requestAnimationFrame(() => {
      scrollAnimationFrame = null;
      if (!shouldFollowMessages() || !messagesContainer) return;
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  /** Unconditional scroll — for explicit user actions (send, load session, done). */
  function scrollToBottom() {
    setShouldFollowMessages(true);
    scheduleScrollToBottom();
  }

  /** Conditional scroll — during streaming, so the user can scroll up mid-response. */
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
      // Also keep the main container scrolled to bottom unless the user scrolled away.
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
      class="messages-container flex-1 space-y-3 overflow-y-auto px-2xs py-4"
      onScroll={onMessagesScroll}
    >
      <Show when={props.sessionStartedAt}>
        <div class="text-center text-neutral-400 text-size-extra-small">
          {formatSessionStartTime(props.sessionStartedAt)}
        </div>
      </Show>
      <For each={props.messages}>
        {(message, index) => (
          <Show when={message.role !== "tool" || message.toolPhase !== "call"}>
            <div
              class="animate-message-slide-in"
              classList={{
                "flex justify-center": message.role === "system",
                "flex gap-2": message.role !== "system",
                "justify-end": message.role === "user",
                "justify-start": message.role !== "user" && message.role !== "system",
              }}
            >
              <Show when={message.role === "system"}>
                <div class="rounded-full bg-neutral-100 px-3 py-1 text-neutral-600 text-size-small">
                  {message.content}
                </div>
              </Show>

              <Show when={message.role === "status"}>
                <div class="status-bubble max-w-[85%] rounded-xl px-3 py-2 shadow-sm">
                  <div class="status-bubble-label mb-1 text-size-extra-small uppercase tracking-wide">
                    Agent log
                  </div>
                  <pre class="whitespace-pre-wrap font-mono text-size-small leading-relaxed">
                    {message.content}
                  </pre>
                </div>
              </Show>

              <Show when={message.role === "thinking"}>
                <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-100">
                  <div
                    class="svg-icon h-4 w-4 text-neutral-500"
                    innerHTML={thinkingIcon}
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex max-h-72 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100 shadow-sm">
                    <div class="shrink-0 border-neutral-200 border-b px-3.5 py-2 font-medium text-neutral-500 text-size-extra-small uppercase tracking-wide">
                      Thinking
                    </div>
                    <pre class="thinking-content min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3.5 py-3 font-mono text-neutral-700 text-size-small leading-relaxed">
                      {message.content}
                    </pre>
                  </div>
                </div>
              </Show>

              <Show when={message.role === "assistant"}>
                {/* Robot avatar */}
                <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary-100 bg-primary-50">
                  <div
                    class="svg-icon h-4 w-4 text-primary-500"
                    innerHTML={agentChatIcon}
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="group relative w-max max-w-full overflow-hidden rounded-xl border border-neutral-100 bg-neutral-10 shadow-sm">
                    <button
                      type="button"
                      class="absolute top-1.5 right-1.5 z-10 rounded p-1 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 focus:opacity-100 group-hover:opacity-100"
                      title={
                        copiedAssistantMessageTimestamp() === message.timestamp
                          ? "Copied!"
                          : "Copy"
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void copyAssistantMessage(message);
                      }}
                    >
                      <Show
                        when={copiedAssistantMessageTimestamp() === message.timestamp}
                        fallback={
                          <div class="svg-icon h-3.5 w-3.5" innerHTML={copyIcon} />
                        }
                      >
                        <div
                          class="svg-icon h-3.5 w-3.5 text-green-600"
                          innerHTML={confirmationIcon}
                        />
                      </Show>
                    </button>
                    <div
                      class="markdown-content px-3.5 py-3 pr-9 text-neutral-800 text-size-medium leading-relaxed"
                      innerHTML={renderMessageMarkdown(message.content)}
                    />
                  </div>
                  <div class="mt-1.5 px-0.5 text-neutral-500 text-size-extra-small">
                    {new Date(message.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {"  ·  Agent"}
                  </div>
                </div>
              </Show>

              <Show when={message.role === "tool"}>
                <div
                  class="ml-9 flex min-w-0"
                  classList={{ "flex-1": isToolMessageExpanded(message, index()) }}
                >
                  <div class="mr-1.5 shrink-0 pt-1.5">
                    <div
                      class="svg-icon tool-message-icon h-4 w-4"
                      innerHTML={linkIcon}
                    />
                  </div>
                  <div class="min-w-0 flex-1">
                    <button
                      type="button"
                      class="tool-message-bg max-w-full cursor-pointer overflow-hidden rounded-lg border text-left transition-colors hover:bg-neutral-100"
                      classList={{
                        "w-full": isToolMessageExpanded(message, index()),
                        "inline-block": !isToolMessageExpanded(message, index()),
                      }}
                      onClick={() => toggleToolMessageExpanded(message, index())}
                    >
                      <div
                        class="tool-message-header flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-size-extra-small"
                        classList={{
                          "border-b": isToolMessageExpanded(message, index()),
                        }}
                      >
                        <span class="tool-message-label shrink-0">Used</span>
                        <span class="tool-message-name truncate font-semibold">
                          {message.toolName || "Tool"}
                        </span>
                        <Show when={collapsedToolInput(message)}>
                          <span class="min-w-0 flex-1 truncate font-normal text-neutral-500">
                            {collapsedToolInput(message)}
                          </span>
                        </Show>
                      </div>
                      <Show when={isToolMessageExpanded(message, index())}>
                        <pre
                          class="overflow-x-auto whitespace-pre-wrap px-3.5 py-3 text-size-small leading-relaxed transition-all"
                          classList={{
                            "tool-error-bg text-red-700": message.isError,
                            "text-neutral-700": !message.isError,
                          }}
                        >
                          {toolPreview(message)}
                        </pre>
                      </Show>
                    </button>
                  </div>
                </div>
              </Show>

              <Show when={message.role === "user"}>
                <div class="ml-auto max-w-[80%] rounded-xl bg-primary-600 px-3.5 py-2.5 text-white">
                  <div
                    class="markdown-content user-markdown text-size-medium leading-relaxed"
                    innerHTML={renderMessageMarkdown(message.content)}
                  />
                  <Show when={message.attachments?.length}>
                    <div class="mt-2 space-y-1.5">
                      <For each={message.attachments}>
                        {(attachment) => (
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="block overflow-hidden rounded-lg border border-white/20 bg-white/10 text-size-small transition-colors hover:bg-white/15"
                          >
                            <Show when={attachment.isImage}>
                              <img
                                src={attachmentPreviewUrl(attachment)}
                                alt={attachment.name}
                                class="block max-h-80 w-full bg-black/10 object-contain"
                                decoding="async"
                                loading="lazy"
                              />
                            </Show>
                            <span class="block px-2 py-1.5">
                              <span class="font-medium">{attachment.name}</span>
                              <span class="ml-1 opacity-80">
                                ({formatFileSize(attachment.size)})
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

      {/* Tool-executing indicator */}
      <Show when={waitingState()?.kind === "tool_executing"}>
        {(_) => {
          const state = waitingState();
          if (state?.kind !== "tool_executing") return null;
          return (
            <div class="flex animate-message-slide-in justify-start">
              <div class="tool-message-bg mt-0.5 ml-9 inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-3 py-1.5 text-size-extra-small">
                <div
                  class="svg-icon tool-message-icon h-4 w-4 shrink-0"
                  innerHTML={linkIcon}
                />
                <span class="tool-message-label shrink-0">Running</span>
                <span class="tool-message-name truncate font-semibold">
                  {state.tool.toolName}
                </span>
                <Show when={collapsedToolInput(state.tool)}>
                  <span class="min-w-0 truncate text-neutral-500">
                    {collapsedToolInput(state.tool)}
                  </span>
                </Show>
                <span class="flex shrink-0 items-center gap-0.5">
                  <TypingDots />
                </span>
              </div>
            </div>
          );
        }}
      </Show>

      {/* Generic waiting indicator (before first event, or model processing a tool result) */}
      <Show when={waitingState()?.kind === "waiting"}>
        <div class="flex animate-message-slide-in justify-start gap-2">
          <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary-100 bg-primary-50">
            <div class="svg-icon h-4 w-4 text-primary-500" innerHTML={agentChatIcon} />
          </div>
          <div class="mt-0.5 flex items-center gap-1 rounded-xl border border-neutral-100 bg-neutral-10 px-3.5 py-3">
            <TypingDots />
          </div>
        </div>
      </Show>
    </div>
  );
}
