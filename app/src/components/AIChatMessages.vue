<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import type { UIMessage } from "#composeables/useChatSessions.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import {
  formatCollapsedToolInput,
  formatToolPreview,
  getMessageKey,
  getToolMessageKey,
} from "#utils/aiToolPreview.ts";
import { formatTime } from "#utils/datetime.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { formatFileSize } from "#utils/utils.ts";
import {
  agentChatIcon,
  confirmationIcon,
  copyIcon,
  linkIcon,
  thinkingIcon,
} from "~/src/assets/icons.ts";

const props = defineProps<{
  messages: UIMessage[];
  isGenerating: boolean;
  sessionStartedAt: number | null;
}>();

function attachmentPreviewUrl(attachment: { url: string }): string {
  return withTransformParams(attachment.url, { w: 640, format: "webp" });
}

const messagesContainer = ref<HTMLElement | null>(null);
const shouldFollowMessages = ref(true);
const expandedToolMessages = ref<Set<string>>(new Set());
const copiedAssistantMessageTimestamp = ref<number | null>(null);

let scrollAnimationFrame: number | null = null;
let clearCopiedAssistantMessageTimer: ReturnType<typeof setTimeout> | null = null;

const messages = computed(() => props.messages);
const isGenerating = computed(() => props.isGenerating);
const sessionStartedAt = computed(() => props.sessionStartedAt);

function formatSessionStartTime(timestamp: number | null): string {
  return timestamp === null ? "" : formatTime(timestamp);
}

const waitingState = computed(
  (): { kind: "tool_executing"; tool: UIMessage } | { kind: "waiting" } | null => {
    if (!isGenerating.value) return null;
    const last = messages.value.at(-1);
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
  return expandedToolMessages.value.has(getToolMessageKey(message, index));
}

function toggleToolMessageExpanded(message: UIMessage, index: number) {
  const key = getToolMessageKey(message, index);
  const next = new Set(expandedToolMessages.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedToolMessages.value = next;
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
  copiedAssistantMessageTimestamp.value = message.timestamp;
  if (clearCopiedAssistantMessageTimer !== null) {
    clearTimeout(clearCopiedAssistantMessageTimer);
  }
  clearCopiedAssistantMessageTimer = setTimeout(() => {
    copiedAssistantMessageTimestamp.value = null;
    clearCopiedAssistantMessageTimer = null;
  }, 2000);
}

function isNearBottom(): boolean {
  const el = messagesContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function onMessagesScroll() {
  shouldFollowMessages.value = isNearBottom();
}

function scheduleScrollToBottom() {
  nextTick(() => {
    if (!shouldFollowMessages.value || scrollAnimationFrame !== null) return;
    scrollAnimationFrame = requestAnimationFrame(() => {
      scrollAnimationFrame = null;
      if (!shouldFollowMessages.value || !messagesContainer.value) return;
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    });
  });
}

/** Unconditional scroll — use for explicit user actions (send, load session, generation done). */
function scrollToBottom() {
  shouldFollowMessages.value = true;
  scheduleScrollToBottom();
}

/** Conditional scroll — use during streaming so the user can freely scroll up mid-response. */
function scrollToBottomIfFollowing() {
  scheduleScrollToBottom();
}

function scrollThinkingToBottom() {
  nextTick(() => {
    const container = messagesContainer.value;
    if (!container) return;
    const pres = container.querySelectorAll(".thinking-content");
    if (!pres.length) return;
    const lastPre = pres[pres.length - 1] as HTMLElement;
    lastPre.scrollTop = lastPre.scrollHeight;
    // Also keep the main container scrolled to bottom unless the user scrolled away.
    scrollToBottomIfFollowing();
  });
}

onUnmounted(() => {
  if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
  if (clearCopiedAssistantMessageTimer !== null) {
    clearTimeout(clearCopiedAssistantMessageTimer);
  }
});

/**
 * The panel drives scrolling — it knows when a send or a stream chunk happened —
 * but this component owns the scroll container, so it hands out the verbs.
 */
defineExpose({ scrollToBottom, scrollToBottomIfFollowing, scrollThinkingToBottom });
</script>

<template>
  <div
    ref="messagesContainer"
    class="flex-1 overflow-y-auto px-2xs py-4 space-y-3 messages-container"
    @scroll="onMessagesScroll"
  >
    <div v-if="sessionStartedAt" class="text-center text-[11px] text-neutral-400">
      {{ formatSessionStartTime(sessionStartedAt) }}
    </div>
    <template v-for="(message, index) in messages" :key="getMessageKey(message, index)">
      <div
        v-if="message.role !== 'tool' || message.toolPhase !== 'call'"
        :class="[
      'animate-message-slide-in',
      message.role === 'system' ? 'flex justify-center' : 'flex gap-2',
      message.role === 'user' ? 'justify-end' : 'justify-start',
    ]"
      >
        <div
          v-if="message.role === 'system'"
          class="px-3 py-1 bg-neutral-100 text-neutral-600 rounded-full text-size-small"
        >
          {{ message.content }}
        </div>
        <div
          v-else-if="message.role === 'status'"
          class="max-w-[85%] status-bubble rounded-xl px-3 py-2 shadow-sm"
        >
          <div class="text-[11px] uppercase tracking-wide status-bubble-label mb-1">
            Agent log
          </div>
          <pre
            class="text-size-small leading-relaxed whitespace-pre-wrap font-mono"
          >{{ message.content }}</pre>
        </div>
        <template v-else-if="message.role === 'thinking'">
          <div
            class="w-7 h-7 rounded-lg bg-neutral-100 border border-neutral-200 flex items-center justify-center shrink-0 mt-0.5"
          >
            <div class="svg-icon w-4 h-4 text-neutral-500" v-html="thinkingIcon" />
          </div>
          <div class="flex-1 min-w-0">
            <div
              class="bg-neutral-100 border border-neutral-200 rounded-xl overflow-hidden shadow-sm max-h-72 flex flex-col"
            >
              <div
                class="px-3.5 py-2 border-b border-neutral-200 text-[11px] font-medium uppercase tracking-wide text-neutral-500 shrink-0"
              >
                Thinking
              </div>
              <pre
                class="px-3.5 py-3 text-size-small leading-relaxed whitespace-pre-wrap font-mono text-neutral-700 overflow-y-auto flex-1 min-h-0 thinking-content"
              >{{ message.content }}</pre>
            </div>
          </div>
        </template>
        <template v-else-if="message.role === 'assistant'">
          <!-- Robot avatar -->
          <div
            class="w-7 h-7 rounded-lg bg-primary-50 border border-primary-100 flex items-center justify-center shrink-0 mt-0.5"
          >
            <div class="svg-icon w-4 h-4 text-primary-500" v-html="agentChatIcon" />
          </div>
          <div class="flex-1 min-w-0">
            <div
              class="group relative bg-neutral-10 border border-neutral-100 rounded-xl overflow-hidden shadow-sm w-max max-w-full"
            >
              <button
                type="button"
                class="absolute right-1.5 top-1.5 z-10 rounded p-1 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 focus:opacity-100 group-hover:opacity-100"
                :title="copiedAssistantMessageTimestamp === message.timestamp ? 'Copied!' : 'Copy'"
                @click.stop="copyAssistantMessage(message)"
              >
                <div
                  v-if="copiedAssistantMessageTimestamp === message.timestamp"
                  class="svg-icon h-3.5 w-3.5 text-green-600"
                  v-html="confirmationIcon"
                />
                <div v-else class="svg-icon h-3.5 w-3.5" v-html="copyIcon" />
              </button>
              <div
                class="px-3.5 py-3 pr-9 text-size-medium text-neutral-800 leading-relaxed markdown-content"
                v-html="renderMessageMarkdown(message.content)"
              ></div>
            </div>
            <div class="mt-1.5 px-0.5 text-[11px] text-neutral-500">
              {{ new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
              &nbsp;·&nbsp; Agent
            </div>
          </div>
        </template>
        <template v-else-if="message.role === 'tool'">
          <div
            class="ml-9 flex min-w-0"
            :class="isToolMessageExpanded(message, index) ? 'flex-1' : ''"
          >
            <div class="mr-1.5 shrink-0 pt-1.5">
              <div class="svg-icon w-4 h-4 tool-message-icon" v-html="linkIcon" />
            </div>
            <div class="flex-1 min-w-0">
              <button
                type="button"
                class="max-w-full text-left border tool-message-bg rounded-lg overflow-hidden cursor-pointer transition-colors hover:bg-neutral-100"
                :class="isToolMessageExpanded(message, index) ? 'w-full' : 'inline-block'"
                @click="toggleToolMessageExpanded(message, index)"
              >
                <div
                  class="px-3 py-1.5 tool-message-header text-[11px] flex items-center gap-1.5 min-w-0"
                  :class="isToolMessageExpanded(message, index) ? 'border-b' : ''"
                >
                  <span class="tool-message-label shrink-0">Used</span>
                  <span class="font-semibold tool-message-name truncate">
                    {{ message.toolName || 'Tool' }}
                  </span>
                  <span
                    v-if="collapsedToolInput(message)"
                    class="min-w-0 flex-1 truncate text-neutral-500 font-normal"
                  >
                    {{ collapsedToolInput(message) }}
                  </span>
                </div>
                <pre
                  v-if="isToolMessageExpanded(message, index)"
                  class="px-3.5 py-3 text-size-small leading-relaxed whitespace-pre-wrap overflow-x-auto transition-all"
                  :class="message.isError ? 'text-red-700 tool-error-bg' : 'text-neutral-700'"
                >{{ toolPreview(message) }}</pre>
              </button>
            </div>
          </div>
        </template>
        <div
          v-else
          class="max-w-[80%] bg-primary-600 text-white rounded-xl px-3.5 py-2.5 ml-auto"
        >
          <div
            class="text-size-medium leading-relaxed markdown-content user-markdown"
            v-html="renderMessageMarkdown(message.content)"
          />
          <div v-if="message.attachments?.length" class="mt-2 space-y-1.5">
            <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
            <a
              v-for="attachment in message.attachments"
              :key="attachment.key"
              :href="attachment.url"
              target="_blank"
              rel="noopener noreferrer"
              class="block overflow-hidden rounded-lg border border-white/20 bg-white/10 text-size-small hover:bg-white/15 transition-colors"
            >
              <img
                v-if="attachment.isImage"
                :src="attachmentPreviewUrl(attachment)"
                :alt="attachment.name"
                class="block max-h-80 w-full object-contain bg-black/10"
                decoding="async"
                loading="lazy"
              >
              <span class="block px-2 py-1.5">
                <span class="font-medium">{{ attachment.name }}</span>
                <span class="opacity-80 ml-1"
                  >({{ formatFileSize(attachment.size) }})</span
                >
              </span>
            </a>
          </div>
        </div>
      </div>
    </template>

    <!-- Tool-executing indicator -->
    <div
      v-if="waitingState?.kind === 'tool_executing'"
      class="flex justify-start animate-message-slide-in"
    >
      <div
        class="ml-9 inline-flex max-w-full min-w-0 items-center gap-1.5 tool-message-bg border rounded-lg px-3 py-1.5 mt-0.5 text-[11px]"
      >
        <div class="svg-icon w-4 h-4 shrink-0 tool-message-icon" v-html="linkIcon" />
        <span class="tool-message-label shrink-0">Running</span>
        <span class="font-semibold tool-message-name truncate">
          {{ waitingState.tool.toolName }}
        </span>
        <span
          v-if="collapsedToolInput(waitingState.tool)"
          class="min-w-0 truncate text-neutral-500"
        >
          {{ collapsedToolInput(waitingState.tool) }}
        </span>
        <span class="flex shrink-0 items-center gap-0.5">
          <span class="typing-dot" />
          <span class="typing-dot" style="animation-delay: 160ms" />
          <span class="typing-dot" style="animation-delay: 320ms" />
        </span>
      </div>
    </div>

    <!-- Generic waiting indicator (before first event, or model processing a tool result) -->
    <div
      v-else-if="waitingState?.kind === 'waiting'"
      class="flex gap-2 justify-start animate-message-slide-in"
    >
      <div
        class="w-7 h-7 rounded-lg bg-primary-50 border border-primary-100 flex items-center justify-center shrink-0 mt-0.5"
      >
        <div class="svg-icon w-4 h-4 text-primary-500" v-html="agentChatIcon" />
      </div>
      <div
        class="flex items-center bg-neutral-10 border border-neutral-100 rounded-xl px-3.5 py-3 gap-1 mt-0.5"
      >
        <span class="typing-dot" />
        <span class="typing-dot" style="animation-delay: 160ms" />
        <span class="typing-dot" style="animation-delay: 320ms" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Disable browser scroll anchoring so it doesn't fight our manual scroll management.
   We handle "stick to bottom" ourselves via scrollToBottomIfFollowing(). */
.messages-container {
  overflow-anchor: none;
}

.animate-message-slide-in {
  animation: messageSlideIn 0.2s ease-out;
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.typing-dot {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: currentColor;
  color: var(--color-neutral-400, #a3a3a3);
  animation: typingBounce 1s ease-in-out infinite;
}

@keyframes typingBounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: var(--color-neutral-200);
  border-radius: 4px;
}

details[open] .details-chevron {
  transform: rotate(90deg);
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(p) {
  margin: 0.25rem 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(:is(h1, h2, h3, h4)) {
  margin: 0.5rem 0;
  font-weight: 600;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(ul) {
  margin: 0.25rem 0;
  padding-left: 1.25rem;
  list-style-type: disc;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(ol) {
  margin: 0.25rem 0;
  padding-left: 1.25rem;
  list-style-type: decimal;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(li) {
  margin: 0.125rem 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(code) {
  background: var(--color-primary-50);
  color: var(--color-primary-700);
  padding: 0.125rem 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.875em;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(pre) {
  background: var(--color-neutral-900);
  color: var(--color-neutral-100);
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  margin: 0.5rem 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(a) {
  color: var(--color-primary-600);
  text-decoration: underline;
}
/* Mention styling comes from #editor/css/mentions.css (imported above). */
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(blockquote) {
  border-left: 3px solid var(--color-neutral-200);
  padding-left: 0.75rem;
  margin: 0.5rem 0;
  color: var(--color-neutral-500);
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(strong) {
  font-weight: 600;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(em) {
  font-style: italic;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(hr) {
  margin: 0.75rem 0;
  border-color: var(--color-neutral-200);
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(table) {
  display: block;
  width: 100%;
  max-width: 100%;
  margin: 0.75rem 0;
  border: 1px solid var(--color-neutral-200);
  border-collapse: separate;
  border-spacing: 0;
  overflow-x: auto;
  table-layout: auto;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(:is(th, td)) {
  min-width: 0;
  padding: 0.375rem 0.5rem;
  border: 0;
  border-right: 1px solid var(--color-neutral-200);
  border-bottom: 1px solid var(--color-neutral-200);
  overflow: visible;
  overflow-wrap: normal;
  text-overflow: clip;
  word-break: normal;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(th) {
  background-color: var(--color-neutral-100);
  color: var(--color-neutral-700);
  font-weight: 600;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(tr > :last-child) {
  border-right: 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(tr:last-child > *) {
  border-bottom: 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(:is(th, td):first-child) {
  width: 1%;
  white-space: nowrap;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(td code) {
  overflow-wrap: anywhere;
  white-space: normal;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.user-markdown :deep(a) {
  color: inherit;
}

/* ── Chat bubble theming ────────────────────────────────────────────── */

.status-bubble {
  background-color: #0b0c10;
  color: #e2e5eb;
  border: 1px solid #2b3140;
}

.status-bubble-label {
  color: var(--color-neutral-400);
}

.tool-message-bg {
  background-color: #f9fafb;
  border-color: #e5e7eb;
}

.tool-message-header {
  border-color: #e5e7eb;
}

.tool-message-name {
  color: #52525b;
}

.tool-message-label {
  color: #a1a1aa;
}

.tool-error-bg {
  background-color: rgba(254, 242, 242, 0.4);
}

@media (prefers-color-scheme: dark) {
  /* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
  .markdown-content :deep(pre) {
    background: var(--color-neutral-200);
    color: var(--color-neutral-800);
  }
  .status-bubble {
    background-color: var(--color-neutral-100);
    color: var(--color-neutral-700);
    border-color: var(--color-neutral-200);
  }
  .status-bubble-label {
    color: var(--color-neutral-500);
  }
  .tool-message-bg {
    background-color: var(--color-neutral-100);
    border-color: var(--color-neutral-200);
  }
  .tool-message-header {
    border-color: var(--color-neutral-200);
  }
  .tool-message-name {
    color: var(--color-neutral-600);
  }
  .tool-message-label {
    color: var(--color-neutral-500);
  }
  .tool-error-bg {
    background-color: rgba(33, 33, 33, 0.4);
  }
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
:root[data-theme="dark"] .markdown-content :deep(pre) {
  background: var(--color-neutral-200);
  color: var(--color-neutral-800);
}
:root[data-theme="dark"] .status-bubble {
  background-color: var(--color-neutral-100);
  color: var(--color-neutral-700);
  border-color: var(--color-neutral-200);
}
:root[data-theme="dark"] .status-bubble-label {
  color: var(--color-neutral-500);
}
:root[data-theme="dark"] .tool-message-bg {
  background-color: var(--color-neutral-100);
  border-color: var(--color-neutral-200);
}
:root[data-theme="dark"] .tool-message-header {
  border-color: var(--color-neutral-200);
}
:root[data-theme="dark"] .tool-message-name {
  color: var(--color-neutral-600);
}
:root[data-theme="dark"] .tool-message-label {
  color: var(--color-neutral-500);
}
:root[data-theme="dark"] .tool-error-bg {
  background-color: rgba(33, 33, 33, 0.4);
}
</style>
