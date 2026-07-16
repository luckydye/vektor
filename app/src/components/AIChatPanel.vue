<script setup lang="ts">
defineOptions({ inheritAttrs: false });

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "#api/client.ts";
import {
  type ChatSession,
  deleteSession,
  getSession,
  getSessionsForSpace,
  saveSession,
  type UIMessage,
} from "#composeables/useChatSessions.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { renderMessageMarkdown } from "#utils/messageMarkdown.ts";
import { normalizeTimestamp } from "#utils/utils.ts";
import {
  checkThinIcon,
  clockIcon,
  copyOutlineIcon,
  pencilSquareIcon,
  plusThinIcon,
  robotIcon,
  sendPlaneIcon,
  stopIcon,
  thinkingIcon,
  trashSmallIcon,
} from "~/src/assets/icons.ts";
import { fetchStreamingCompletion } from "./ai-chat/providers/shared.ts";
import type { ChatStreamEvent } from "./ai-chat/types.ts";
import DockedPanel from "./DockedPanel.vue";
import type { PendingAttachment } from "./MessageInput.vue";
import MessageInput from "./MessageInput.vue";

const props = defineProps({
  documentId: {
    type: String,
    default: "",
  },
});

type UploadedAttachment = {
  key: string;
  url: string;
  name: string;
  type: string;
  size: number;
  isImage: boolean;
};

// ── State ─────────────────────────────────────────────────────────────────────

const { currentSpaceId } = useSpace();
const { toggle: toggleWindow, windows: dockedWindows } = useDockedWindows();
const { uploadFiles } = useUploads();
const isOpen = computed(() => dockedWindows.value.get("ai-chat")?.open ?? false);
const messageInput = ref("");
const messages = ref<UIMessage[]>([]);
const messagesContainer = ref<HTMLElement | null>(null);
const isGenerating = ref(false);
const messageInputEl = ref<InstanceType<typeof MessageInput> | null>(null);
const isUploadingFiles = ref(false);
const uploadError = ref("");
const expandedToolMessages = ref<Set<string>>(new Set());
const shouldFollowMessages = ref(true);
const copiedAssistantMessageTimestamp = ref<number | null>(null);

let abortController: AbortController | null = null;
let scrollAnimationFrame: number | null = null;
let clearCopiedAssistantMessageTimer: ReturnType<typeof setTimeout> | null = null;

// Session persistence
const currentSessionId = ref<string | null>(null);
const sessions = ref<ChatSession[]>([]);
const showSessionPicker = ref(false);
const sessionStartedAt = computed(() => {
  const session = sessions.value.find((item) => item.id === currentSessionId.value);
  return session?.createdAt ?? messages.value[0]?.timestamp ?? null;
});

// ── UI state persistence ──────────────────────────────────────────────────────

function loadUIState() {
  // State is now managed by useDockedWindows composable with localStorage persistence.
  // Migrate old state format if present.
  const saved = localStorage.getItem("ai-chat-ui-state");
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved) as {
      isOpen?: boolean;
      isDocked?: boolean;
      dockSide?: "left" | "right";
    };
    if (parsed.isOpen) {
      toggleWindow("ai-chat", {
        mode: parsed.isDocked ? "docked" : "floating",
        side: parsed.dockSide ?? "right",
        width: 380,
      });
    }
    localStorage.removeItem("ai-chat-ui-state");
  } catch {
    localStorage.removeItem("ai-chat-ui-state");
  }
}

const canSend = computed(() => {
  return !isGenerating.value && !isUploadingFiles.value;
});

/**
 * The current generation state from the perspective of the waiting indicator.
 * - 'tool_executing': a tool_call message is at the tail — tool is running on server
 * - 'waiting': generating but nothing is actively streaming (pre-first-event, or model
 *              processing a tool result before responding)
 * - null: not generating, or content is actively streaming (text / thinking / status)
 */
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAttachmentContext(attachments: UploadedAttachment[]): string {
  if (attachments.length === 0) return "";
  const fileLines = attachments.map((file) => {
    return `- ${file.name} (${file.type || "unknown"}, ${formatFileSize(file.size)}): ${file.url}`;
  });
  return `Attached files:\n${fileLines.join("\n")}\nUse these files when relevant.`;
}

function formatSessionDate(date: string | number | Date): string {
  return normalizeTimestamp(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatSessionStartTime(timestamp: number | null): string {
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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

type SessionStatus = "generating" | "awaiting" | "idle";

function getSessionStatus(session: ChatSession): SessionStatus {
  if (session.id === currentSessionId.value && isGenerating.value) {
    return "generating";
  }
  const lastMsg = (session.conversationHistory as Array<{ role: string }>).at(-1);
  if (lastMsg?.role === "user") {
    return "awaiting";
  }
  return "idle";
}

function parseReferencedDocuments(message: string): Array<{ id: string; title: string }> {
  const references: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  const regex = /(?:@\[([^\]]+)\]|\[@([^\]]+)\])\(doc:([^)]+)\)/g;
  for (const match of message.matchAll(regex)) {
    const title = (match[1] ?? match[2])?.trim();
    const id = match[3]?.trim();
    if (!title || !id || seen.has(id)) continue;
    seen.add(id);
    references.push({ id, title });
  }
  return references;
}

function buildDocumentReferenceContext(message: string): string {
  const refs = parseReferencedDocuments(message);
  if (refs.length === 0) return "";
  const lines = refs.map((doc) => `- ${doc.title} (documentId: ${doc.id})`);
  return `Referenced documents:\n${lines.join("\n")}\nUse these document IDs with tools when relevant.`;
}

function appendAssistantMessageChunk(
  text: string,
  assistantMessageIndex: { value: number | null },
) {
  if (!text) return;
  const existing =
    assistantMessageIndex.value === null
      ? null
      : messages.value[assistantMessageIndex.value];
  if (existing?.role !== "assistant") {
    messages.value.push({
      role: "assistant",
      content: text,
      timestamp: Date.now(),
    });
    assistantMessageIndex.value = messages.value.length - 1;
    return;
  }
  existing.content += text;
}

function appendThinkingMessageChunk(
  text: string,
  thinkingMessageIndex: { value: number | null },
) {
  if (!text) return;
  const existing =
    thinkingMessageIndex.value === null
      ? null
      : messages.value[thinkingMessageIndex.value];
  if (existing?.role !== "thinking") {
    messages.value.push({
      role: "thinking",
      content: text,
      timestamp: Date.now(),
    });
    thinkingMessageIndex.value = messages.value.length - 1;
    scrollThinkingToBottom();
    return;
  }
  existing.content += text;
  scrollThinkingToBottom();
}

function appendToolEventMessage(
  event: Extract<ChatStreamEvent, { type: "tool_call" | "tool_result" }>,
) {
  messages.value.push({
    role: "tool",
    content: event.type === "tool_call" ? event.toolArguments : event.content,
    timestamp: Date.now(),
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    toolPhase: event.type === "tool_call" ? "call" : "result",
    isError: event.type === "tool_result" ? event.isError : false,
  });
}

function removeThinkingMessages(startIndex: number) {
  messages.value = messages.value.filter(
    (message, index) => !(index >= startIndex && message.role === "thinking"),
  );
}

function applyStreamEvent(
  event: ChatStreamEvent,
  assistantMessageIndex: { value: number | null },
  thinkingMessageIndex: { value: number | null },
  responseStartIndex: number,
) {
  if (event.type === "text") {
    removeThinkingMessages(responseStartIndex);
    appendAssistantMessageChunk(event.text, assistantMessageIndex);
  } else if (event.type === "thinking") {
    appendThinkingMessageChunk(event.text, thinkingMessageIndex);
  } else if (event.type === "status") {
    appendStatusMessage(event.text);
  } else if (event.type === "tool_progress") {
    // Tool is actively running — the waitingState indicator already reflects this
    // from the tool_call message at the tail; nothing extra to render.
  } else {
    // tool_call or tool_result
    removeThinkingMessages(responseStartIndex);
    assistantMessageIndex.value = null;
    thinkingMessageIndex.value = null;
    if (event.type === "tool_call") {
      clearTransientStatusMessages(responseStartIndex);
    }
    appendToolEventMessage(event);
  }
  scrollToBottomIfFollowing();
}

function appendStatusMessage(text: string) {
  const lastMessage = messages.value.at(-1);
  if (lastMessage?.role === "status") {
    const lines = lastMessage.content.split("\n").filter(Boolean);
    if (lines.at(-1) !== text) {
      lastMessage.content = `${lastMessage.content}\n${text}`;
    }
    lastMessage.timestamp = Date.now();
    return;
  }

  messages.value.push({
    role: "status",
    content: text,
    timestamp: Date.now(),
  });
}

function clearTransientStatusMessages(startIndex: number) {
  messages.value = messages.value.filter(
    (message, index) => !(index >= startIndex && message.role === "status"),
  );
}

function normalizeSavedMessage(message: UIMessage): UIMessage {
  return {
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
    attachments: message.attachments,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    toolPhase: message.toolPhase,
    isError: message.isError,
  };
}

function collectAssistantText(startIndex: number): string {
  return messages.value
    .slice(startIndex)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("");
}

function collectThinkingText(startIndex: number): string {
  return messages.value
    .slice(startIndex)
    .filter((message) => message.role === "thinking")
    .map((message) => message.content)
    .join("");
}

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

function getBashCommandFromToolCallMessage(message: UIMessage): string | null {
  if (message.toolName !== "bash" || message.toolPhase !== "call") {
    return null;
  }
  const args = parseToolArguments(message.content);
  const command = args?.command;
  return typeof command === "string" && command.trim() ? command : null;
}

function findBashCommandForResultMessage(message: UIMessage): string | null {
  if (message.toolName !== "bash" || message.toolPhase !== "result") {
    return null;
  }
  const toolCallId = message.toolCallId;
  if (!toolCallId) {
    return null;
  }
  const toolCallMessage = messages.value.find(
    (candidate) =>
      candidate.toolCallId === toolCallId &&
      candidate.toolName === "bash" &&
      candidate.toolPhase === "call",
  );
  return toolCallMessage ? getBashCommandFromToolCallMessage(toolCallMessage) : null;
}

function formatBashResultPreview(message: UIMessage, result: unknown): string {
  const output =
    typeof result === "string"
      ? result.trim() || "(no output)"
      : formatValuePreview(result);
  const command = findBashCommandForResultMessage(message);
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

function formatToolPreview(message: UIMessage): string {
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
    return formatBashResultPreview(message, result);
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

function formatCollapsedToolInput(message: UIMessage): string {
  if (message.toolPhase !== "call") return "";
  const preview = formatToolPreview(message).replace(/\s+/g, " ").trim();
  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
}

function getToolMessageKey(message: UIMessage, index: number): string {
  return message.toolCallId
    ? `${message.toolCallId}:${message.toolPhase ?? "unknown"}`
    : `tool:${index}:${message.timestamp}`;
}

function getMessageKey(message: UIMessage, index: number): string {
  if (message.role === "tool") {
    return getToolMessageKey(message, index);
  }
  return `${message.role}:${message.timestamp}:${index}`;
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

// ── Send to agent ─────────────────────────────────────────────────────────────

async function streamAssistantResponse(
  userMessage: string,
  responseStartIndex: number,
  additionalContext = "",
) {
  const assistantMessageIndex = { value: null as number | null };
  const thinkingMessageIndex = { value: null as number | null };

  await fetchStreamingCompletion({
    url: "/api/v1/chat/acp",
    sessionId: currentSessionId.value!,
    spaceId: currentSpaceId.value!,
    documentId: props.documentId || undefined,
    userMessage,
    additionalContext: additionalContext || undefined,
    onEvent: (event) =>
      applyStreamEvent(
        event,
        assistantMessageIndex,
        thinkingMessageIndex,
        responseStartIndex,
      ),
    signal: abortController?.signal,
  });
}

// ── Session management ────────────────────────────────────────────────────────

async function loadSessions() {
  if (!currentSpaceId.value) return;
  sessions.value = await getSessionsForSpace(currentSpaceId.value);
}

watch(
  currentSpaceId,
  async (id) => {
    if (!id) return;
    await loadSessions();
    if (sessions.value.length > 0) {
      showSessionPicker.value = true;
    } else if (messages.value.length === 0) {
      messages.value.push({
        role: "assistant",
        content: "Hello! I'm here to help you with this document. Ask me anything!",
        timestamp: Date.now(),
      });
    }
  },
  { immediate: true },
);

function startNewChat() {
  currentSessionId.value = null;
  messages.value = [];
  uploadError.value = "";
  messageInputEl.value?.clearAttachments();
  showSessionPicker.value = false;
  messages.value.push({
    role: "assistant",
    content: "Hello! I'm here to help you with this document. Ask me anything!",
    timestamp: Date.now(),
  });
}

function resumeSession(session: ChatSession) {
  currentSessionId.value = session.id;
  uploadError.value = "";
  messageInputEl.value?.clearAttachments();
  messages.value = (session.messages as UIMessage[]).map(normalizeSavedMessage);
  showSessionPicker.value = false;
  scrollToBottom();

  // If the session was interrupted while the agent was responding, the history
  // will end with a user message (pre-saved before the agent started).  Connect
  // back to the in-progress turn (or restart it if the server already finished).
  const conversationArr = session.conversationHistory as Array<{
    role: string;
    content?: string;
  }>;
  const lastHistoryMsg = conversationArr.at(-1);
  if (lastHistoryMsg?.role === "user" && typeof lastHistoryMsg.content === "string") {
    void nextTick(() => void reconnectSession(lastHistoryMsg.content!));
  }
}

async function reconnectSession(pendingUserMessage: string) {
  if (isGenerating.value || !currentSessionId.value) return;
  isGenerating.value = true;
  abortController = new AbortController();
  const responseStartIndex = messages.value.length;

  try {
    await streamAssistantResponse(
      pendingUserMessage,
      responseStartIndex,
      buildDocumentReferenceContext(pendingUserMessage),
    );
    if (currentSessionId.value && currentSpaceId.value) {
      const refreshed = await getSession(currentSpaceId.value, currentSessionId.value);
      if (refreshed) {
        const idx = sessions.value.findIndex((s) => s.id === refreshed.id);
        if (idx !== -1) sessions.value[idx] = refreshed;
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      const errorMessage =
        error instanceof Error ? error.message : "AI generation failed";
      messages.value.push({
        role: "assistant",
        content: `Sorry, I encountered an error: ${errorMessage}`,
        timestamp: Date.now(),
      });
    }
  } finally {
    clearTransientStatusMessages(responseStartIndex);
    removeThinkingMessages(responseStartIndex);
    abortController = null;
    isGenerating.value = false;
    scrollToBottomIfFollowing();
  }
}

async function removeSession(id: string) {
  const session = sessions.value.find((item) => item.id === id);
  if (!session) return;
  await deleteSession(session.spaceId, id);
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (currentSessionId.value === id) {
    if (sessions.value.length > 0) {
      showSessionPicker.value = true;
      currentSessionId.value = null;
      messages.value = [];
    } else {
      startNewChat();
    }
  }
}

// ── Send message ──────────────────────────────────────────────────────────────

function cancelGeneration() {
  // Send session/cancel so the server can abort the agent worker.
  // Without this the server cannot distinguish an intentional cancel from an
  // accidental disconnect, and the agent would keep running in the background.
  if (currentSessionId.value && currentSpaceId.value) {
    void api.aiChatSessions.cancel(currentSpaceId.value, currentSessionId.value);
  }
  abortController?.abort();
  abortController = null;
}

async function sendMessage() {
  if (!canSend.value) return;

  const message = messageInput.value.trim();
  const attachmentsToUpload = [...(messageInputEl.value?.pendingAttachments ?? [])];
  uploadError.value = "";

  showSessionPicker.value = false;

  if (!currentSessionId.value) {
    const newSession: ChatSession = {
      id: crypto.randomUUID(),
      title: (message || attachmentsToUpload[0]?.name || "New chat").slice(0, 60),
      spaceId: currentSpaceId.value,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      conversationHistory: [],
    };
    sessions.value.unshift(newSession);
    currentSessionId.value = newSession.id;
    await saveSession(newSession);
  }

  let uploadedAttachments: UploadedAttachment[] = [];
  if (attachmentsToUpload.length > 0) {
    if (!currentSpaceId.value) {
      uploadError.value = "No active space selected";
      return;
    }
    isUploadingFiles.value = true;
    try {
      // The upload manager shows an aggregated progress toast; this panel
      // keeps its own busy flag and inline error, so errorToast is disabled.
      const results = await uploadFiles(
        attachmentsToUpload.map((attachment) => attachment.file),
        {
          spaceId: currentSpaceId.value,
          documentId: props.documentId || undefined,
          errorToast: false,
        },
      );
      uploadedAttachments = results.map((result, index) => {
        const attachment = attachmentsToUpload[index];
        return {
          key: result.key as string,
          url: result.url as string,
          name: attachment.name,
          type: attachment.type,
          size: attachment.size,
          isImage: attachment.type.startsWith("image/"),
        };
      });
    } catch (error) {
      uploadError.value =
        error instanceof Error ? error.message : "Failed to upload attachments";
      isUploadingFiles.value = false;
      return;
    } finally {
      isUploadingFiles.value = false;
    }
  }

  const userDisplayText =
    message ||
    `Uploaded ${uploadedAttachments.length} attachment${uploadedAttachments.length > 1 ? "s" : ""}`;
  const additionalContext = [
    buildDocumentReferenceContext(message),
    buildAttachmentContext(uploadedAttachments),
  ]
    .filter(Boolean)
    .join("\n\n");

  messages.value.push({
    role: "user",
    content: userDisplayText,
    timestamp: Date.now(),
    attachments: uploadedAttachments,
  });
  messageInput.value = "";
  messageInputEl.value?.clearAttachments();
  scrollToBottom();

  isGenerating.value = true;
  abortController = new AbortController();
  const responseStartIndex = messages.value.length;

  try {
    await streamAssistantResponse(userDisplayText, responseStartIndex, additionalContext);
    // Reload the session so sessions.value reflects the messages persistCompletedChatTurn saved.
    if (currentSessionId.value && currentSpaceId.value) {
      const refreshed = await getSession(currentSpaceId.value, currentSessionId.value);
      if (refreshed) {
        const idx = sessions.value.findIndex((s) => s.id === refreshed.id);
        if (idx !== -1) sessions.value[idx] = refreshed;
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      // cancelled — server already notified via session/cancel
    } else {
      const errorMessage =
        error instanceof Error ? error.message : "AI generation failed";
      messages.value.push({
        role: "assistant",
        content: `Sorry, I encountered an error: ${errorMessage}`,
        timestamp: Date.now(),
      });
    }
  } finally {
    clearTransientStatusMessages(responseStartIndex);
    removeThinkingMessages(responseStartIndex);
    abortController = null;
    isGenerating.value = false;
    scrollToBottomIfFollowing();
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

Actions.register("ai-chat:toggle", {
  title: t("AI Chat"),
  icon: () => "sparkles",
  description: t("Open AI chat to ask questions about this document"),
  group: "document",
  run: async () => {
    toggleWindow("ai-chat", { side: "right", width: 380 });
  },
});

onMounted(() => {
  loadUIState();
});

onUnmounted(() => {
  Actions.unregister("ai-chat:toggle");
  if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
  if (clearCopiedAssistantMessageTimer !== null) {
    clearTimeout(clearCopiedAssistantMessageTimer);
  }
});
</script>

<template>
  <DockedPanel
    id="ai-chat"
    title="AI Assistant"
    default-side="right"
    :default-width="380"
  >
    <div class="flex flex-col h-full bg-neutral-50">
      <!-- Session toolbar -->
      <div
        v-if="!showSessionPicker"
        class="flex shrink-0 items-center gap-3 border-b border-neutral-100 bg-neutral-10 px-3 py-2"
      >
        <button
          type="button"
          @click="startNewChat"
          :disabled="isGenerating"
          class="flex items-center gap-1.5 text-size-small text-neutral-500 hover:text-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="New chat"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="pencilSquareIcon" />
          New chat
        </button>
        <div class="flex-1" />
        <button
          v-if="sessions.length > 0"
          type="button"
          @click="showSessionPicker = true"
          class="flex items-center gap-1.5 text-size-small text-neutral-500 hover:text-neutral-700 transition-colors"
          title="Recent conversations"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="clockIcon" />
          History
        </button>
      </div>

      <!-- Sessions picker -->
      <div v-if="showSessionPicker" class="flex-1 overflow-y-auto px-3 py-4">
        <div class="flex items-center justify-between mb-3 px-1">
          <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wide">
            Recent conversations
          </p>
          <button
            type="button"
            @click="startNewChat"
            class="flex items-center gap-1 text-size-small text-primary-600 hover:text-primary-700 font-medium transition-colors"
          >
            <div class="svg-icon w-3.5 h-3.5" v-html="plusThinIcon" />
            New chat
          </button>
        </div>
        <div class="space-y-0.5">
          <!-- biome-ignore lint/a11y/noStaticElementInteractions: The row preserves the surrounding list layout and is activated by Vue click handling. -->
          <!-- biome-ignore lint/a11y/useKeyWithClickEvents: Session navigation is handled by the surrounding keyboard command interface. -->
          <div
            v-for="session in sessions"
            :key="session.id"
            class="group flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-neutral-100 cursor-pointer transition-colors"
            @click="resumeSession(session)"
          >
            <!-- Status dot -->
            <div class="shrink-0 mt-0.5">
              <span
                v-if="getSessionStatus(session) === 'generating'"
                class="block w-2 h-2 rounded-full bg-primary-500 animate-pulse"
              />
              <span
                v-else-if="getSessionStatus(session) === 'awaiting'"
                class="block w-2 h-2 rounded-full bg-amber-400"
              />
              <span v-else class="block w-2 h-2 rounded-full bg-neutral-200" />
            </div>

            <div class="flex-1 min-w-0">
              <p class="text-size-medium text-neutral-800 truncate">
                {{ session.title }}
              </p>
              <p class="text-size-small mt-0.5">
                <template v-if="getSessionStatus(session) === 'generating'">
                  <span class="text-primary-500 font-medium">Generating response…</span>
                </template>
                <template v-else-if="getSessionStatus(session) === 'awaiting'">
                  <span class="text-amber-500 font-medium">Awaiting response</span>
                </template>
                <template v-else>
                  <span class="text-neutral-400"
                    >{{ formatSessionDate(session.updatedAt) }}</span
                  >
                </template>
              </p>
            </div>

            <button
              type="button"
              @click.stop="removeSession(session.id)"
              class="opacity-0 group-hover:opacity-100 p-1 text-neutral-400 hover:text-red-500 transition-all shrink-0"
              title="Delete"
            >
              <div class="svg-icon w-3.5 h-3.5" v-html="trashSmallIcon" />
            </button>
          </div>
        </div>
      </div>

      <!-- Messages -->
      <div
        v-else
        ref="messagesContainer"
        class="flex-1 overflow-y-auto px-2xs py-4 space-y-3 messages-container"
        @scroll="onMessagesScroll"
      >
        <div v-if="sessionStartedAt" class="text-center text-[11px] text-neutral-400">
          {{ formatSessionStartTime(sessionStartedAt) }}
        </div>
        <template
          v-for="(message, index) in messages"
          :key="getMessageKey(message, index)"
        >
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
                <div class="svg-icon w-4 h-4 text-primary-500" v-html="robotIcon" />
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
                      v-html="checkThinIcon"
                    />
                    <div v-else class="svg-icon h-3.5 w-3.5" v-html="copyOutlineIcon" />
                  </button>
                  <div
                    class="px-3.5 py-3 pr-9 text-size-medium text-neutral-800 leading-relaxed markdown-content"
                    v-html="renderMessageMarkdown(message.content)"
                  ></div>
                </div>
              </div>
            </template>
            <template v-else-if="message.role === 'tool'">
              <div
                class="ml-9 flex min-w-0"
                :class="isToolMessageExpanded(message, index) ? 'flex-1' : ''"
              >
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
                      v-if="formatCollapsedToolInput(message)"
                      class="min-w-0 flex-1 truncate text-neutral-500 font-normal"
                    >
                      {{ formatCollapsedToolInput(message) }}
                    </span>
                  </div>
                  <pre
                    v-if="isToolMessageExpanded(message, index)"
                    class="px-3.5 py-3 text-size-small leading-relaxed whitespace-pre-wrap overflow-x-auto transition-all"
                    :class="message.isError ? 'text-red-700 tool-error-bg' : 'text-neutral-700'"
                  >{{ formatToolPreview(message) }}</pre>
                </button>
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
                  class="block rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-size-small hover:bg-white/15 transition-colors"
                >
                  <span class="font-medium">{{ attachment.name }}</span>
                  <span class="opacity-80 ml-1"
                    >({{ formatFileSize(attachment.size) }})</span
                  >
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
            <span class="tool-message-label shrink-0">Running</span>
            <span class="font-semibold tool-message-name truncate">
              {{ waitingState.tool.toolName }}
            </span>
            <span
              v-if="formatCollapsedToolInput(waitingState.tool)"
              class="min-w-0 truncate text-neutral-500"
            >
              {{ formatCollapsedToolInput(waitingState.tool) }}
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
            <div class="svg-icon w-4 h-4 text-primary-500" v-html="robotIcon" />
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

      <!-- Input bar -->
      <div class="px-3 pb-2 pt-2 shrink-0">
        <div class="px-3 py-2 bg-neutral-10 border border-neutral-100 rounded-md">
          <MessageInput
            ref="messageInputEl"
            v-model="messageInput"
            placeholder="Ask anything..."
            :rows="3"
            auto-grow
            attachments
            mentions
            inline-document-references
            :space-id="currentSpaceId"
            :document-id="documentId"
            :disabled="!canSend"
            :is-uploading="isUploadingFiles"
            :upload-error="uploadError"
            @submit="sendMessage"
          >
            <template #actions>
              <button
                v-if="isGenerating"
                type="button"
                @click="cancelGeneration"
                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 hover:text-red-500 transition-colors"
                title="Stop generating"
              >
                <div class="svg-icon w-4 h-4" v-html="stopIcon" />
              </button>
              <button
                v-else
                type="button"
                @click="sendMessage"
                :disabled="!canSend"
                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 hover:text-primary-500 disabled:opacity-40 transition-colors"
                title="Send (↵)"
              >
                <div class="svg-icon w-4 h-4" v-html="sendPlaneIcon" />
              </button>
            </template>
          </MessageInput>
        </div>
      </div>
    </div>
  </DockedPanel>
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
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.markdown-content :deep(document-mention),
.markdown-content :deep(a[href^="doc:"]),
.markdown-content :deep(a[href*="/doc/"]) {
  background: var(--color-neutral-50);
  border: 1px solid var(--color-neutral-200);
  border-radius: 0.375rem;
  color: var(--color-primary-700);
  cursor: default;
  font-weight: 500;
  padding: 0.0625rem 0.3125rem;
  text-decoration: none;
  white-space: nowrap;
}
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
