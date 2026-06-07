<script setup lang="ts">
import { marked } from "marked";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { DocumentWithProperties } from "../api/ApiClient.ts";
import { api } from "../api/client.ts";
import {
  type ChatSession,
  deleteSession,
  getSession,
  getSessionsForSpace,
  saveSession,
  type UIMessage,
} from "../composeables/useChatSessions.ts";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { Actions } from "../utils/actions.ts";
import { normalizeTimestamp } from "../utils/utils.ts";
import { fetchStreamingCompletion } from "./ai-chat/providers/shared.ts";
import type { ChatStreamEvent } from "./ai-chat/types.ts";

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

type PendingAttachment = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
};

type MentionSuggestion = {
  id: string;
  slug: string;
  title: string;
};

// ── State ─────────────────────────────────────────────────────────────────────

const { currentSpaceId } = useSpace();
const { toggle: toggleWindow, windows: dockedWindows } = useDockedWindows();
const isOpen = computed(() => dockedWindows.value.get("ai-chat")?.open ?? false);
const messageInput = ref("");
const messages = ref<UIMessage[]>([]);
const messagesContainer = ref<HTMLElement | null>(null);
const isGenerating = ref(false);
const messageInputEl = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const pendingAttachments = ref<PendingAttachment[]>([]);
const isUploadingFiles = ref(false);
const uploadError = ref("");
const mentionOpen = ref(false);
const mentionQuery = ref("");
const mentionSuggestions = ref<MentionSuggestion[]>([]);
const mentionActiveIndex = ref(0);
const mentionLoading = ref(false);
const mentionStart = ref(-1);
const mentionEnd = ref(-1);
const mentionDocsSpaceId = ref("");
const mentionDocsCache = ref<DocumentWithProperties[]>([]);
const mentionAnchorEl = ref<HTMLElement | null>(null);
const mentionOverlayStyle = ref<Record<string, string>>({});
const expandedToolMessages = ref<Set<string>>(new Set());
let mentionReqSeq = 0;

let abortController: AbortController | null = null;

// Session persistence
const currentSessionId = ref<string | null>(null);
const sessions = ref<ChatSession[]>([]);
const showSessionPicker = ref(false);

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
  return !!(
    !isGenerating.value &&
    !isUploadingFiles.value &&
    (messageInput.value.trim() || pendingAttachments.value.length > 0)
  );
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

function openFilePicker() {
  fileInput.value?.click();
}

function revokePreviewUrl(url?: string) {
  if (!url) return;
  URL.revokeObjectURL(url);
}

function clearPendingAttachments() {
  for (const attachment of pendingAttachments.value) {
    revokePreviewUrl(attachment.previewUrl);
  }
  pendingAttachments.value = [];
}

function removePendingAttachment(id: string) {
  const index = pendingAttachments.value.findIndex((file) => file.id === id);
  if (index < 0) return;
  const [removed] = pendingAttachments.value.splice(index, 1);
  revokePreviewUrl(removed.previewUrl);
}

function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  addPendingFiles(input.files);
  input.value = "";
}

function onDropFiles(event: DragEvent) {
  if (!event.dataTransfer?.files?.length || isGenerating.value) return;
  event.preventDefault();
  addPendingFiles(event.dataTransfer.files);
}

function onPasteFiles(event: ClipboardEvent) {
  if (!event.clipboardData?.files?.length || isGenerating.value) return;
  addPendingFiles(event.clipboardData.files);
}

function addPendingFiles(fileList: FileList) {
  uploadError.value = "";
  const next: PendingAttachment[] = [];
  for (const file of Array.from(fileList)) {
    const isImage = file.type.startsWith("image/");
    next.push({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      previewUrl: isImage ? URL.createObjectURL(file) : undefined,
    });
  }
  pendingAttachments.value = [...pendingAttachments.value, ...next];
}

function buildMessageWithAttachments(
  message: string,
  attachments: UploadedAttachment[],
): string {
  if (attachments.length === 0) return message;
  const fileLines = attachments.map((file) => {
    return `- ${file.name} (${file.type || "unknown"}, ${formatFileSize(file.size)}): ${file.url}`;
  });
  const fileContext = `Attached files:\n${fileLines.join("\n")}\nUse these files when relevant.`;
  return message ? `${message}\n\n${fileContext}` : fileContext;
}

function getDocumentTitle(doc: DocumentWithProperties): string {
  return doc.properties?.title?.trim() || doc.slug;
}

function closeMentionSuggestions() {
  mentionOpen.value = false;
  mentionSuggestions.value = [];
  mentionActiveIndex.value = 0;
  mentionLoading.value = false;
  mentionStart.value = -1;
  mentionEnd.value = -1;
}

function updateMentionOverlayPosition() {
  const anchor = mentionAnchorEl.value;
  if (!anchor || !mentionOpen.value) return;
  const rect = anchor.getBoundingClientRect();
  mentionOverlayStyle.value = {
    position: "fixed",
    left: `${Math.max(8, rect.left)}px`,
    top: `${Math.max(8, rect.top - 8)}px`,
    width: `${Math.max(260, rect.width)}px`,
    transform: "translateY(-100%)",
    zIndex: "80",
  };
}

async function ensureMentionDocs(): Promise<DocumentWithProperties[]> {
  if (!currentSpaceId.value) return [];
  if (
    mentionDocsSpaceId.value === currentSpaceId.value &&
    mentionDocsCache.value.length > 0
  ) {
    return mentionDocsCache.value;
  }
  const response = await api.documents.get(currentSpaceId.value, {
    limit: 1000,
    offset: 0,
  });
  mentionDocsSpaceId.value = currentSpaceId.value;
  mentionDocsCache.value = response.documents || [];
  return mentionDocsCache.value;
}

async function updateMentionSuggestions() {
  const textarea = messageInputEl.value;
  if (!textarea) {
    closeMentionSuggestions();
    return;
  }

  const caret = textarea.selectionStart ?? messageInput.value.length;
  const beforeCaret = messageInput.value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)@([a-zA-Z0-9._/-]*)$/);
  if (!match) {
    closeMentionSuggestions();
    return;
  }

  mentionQuery.value = match[1] || "";
  mentionStart.value = caret - mentionQuery.value.length - 1;
  mentionEnd.value = caret;
  mentionOpen.value = true;
  mentionLoading.value = true;
  updateMentionOverlayPosition();
  const seq = ++mentionReqSeq;

  try {
    const docs = await ensureMentionDocs();
    if (seq !== mentionReqSeq) return;
    const query = mentionQuery.value.trim().toLowerCase();
    const filtered = [...docs]
      .filter((doc) => {
        const title = getDocumentTitle(doc).toLowerCase();
        const slug = doc.slug.toLowerCase();
        if (!query) return true;
        return title.includes(query) || slug.includes(query);
      })
      .sort((a, b) => {
        const aTime = normalizeTimestamp(a.updatedAt).getTime();
        const bTime = normalizeTimestamp(b.updatedAt).getTime();
        return bTime - aTime;
      })
      .slice(0, 8)
      .map((doc) => ({ id: doc.id, slug: doc.slug, title: getDocumentTitle(doc) }));

    mentionSuggestions.value = filtered;
    mentionActiveIndex.value = 0;
    if (filtered.length === 0) {
      mentionOpen.value = false;
    }
  } catch {
    if (seq === mentionReqSeq) {
      closeMentionSuggestions();
    }
  } finally {
    if (seq === mentionReqSeq) {
      mentionLoading.value = false;
    }
  }
}

function onMessageInput() {
  updateMentionSuggestions();
  nextTick(updateMentionOverlayPosition);
}

function formatSessionDate(date: string | number | Date): string {
  return normalizeTimestamp(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

function selectMention(suggestion: MentionSuggestion) {
  const start = mentionStart.value;
  const end = mentionEnd.value;
  if (start < 0 || end < 0) return;
  const token = `@[${suggestion.title}](doc:${suggestion.id}) `;
  const before = messageInput.value.slice(0, start);
  const after = messageInput.value.slice(end);
  messageInput.value = `${before}${token}${after}`;
  closeMentionSuggestions();

  nextTick(() => {
    const textarea = messageInputEl.value;
    if (!textarea) return;
    const nextPos = before.length + token.length;
    textarea.focus();
    textarea.setSelectionRange(nextPos, nextPos);
  });
}

function onMessageKeydown(event: KeyboardEvent) {
  nextTick(updateMentionOverlayPosition);
  if (mentionOpen.value && mentionSuggestions.value.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      mentionActiveIndex.value =
        (mentionActiveIndex.value + 1) % mentionSuggestions.value.length;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      mentionActiveIndex.value =
        (mentionActiveIndex.value - 1 + mentionSuggestions.value.length) %
        mentionSuggestions.value.length;
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const active = mentionSuggestions.value[mentionActiveIndex.value];
      if (active) selectMention(active);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionSuggestions();
      return;
    }
  }

  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendMessage();
  }
}

function parseReferencedDocuments(message: string): MentionSuggestion[] {
  const references: MentionSuggestion[] = [];
  const seen = new Set<string>();
  const regex = /@\[([^\]]+)\]\(doc:([^)]+)\)/g;
  for (const match of message.matchAll(regex)) {
    const title = match[1]?.trim();
    const id = match[2]?.trim();
    if (!title || !id || seen.has(id)) continue;
    seen.add(id);
    references.push({ id, title, slug: "" });
  }
  return references;
}

function buildMessageWithDocumentReferences(message: string): string {
  const refs = parseReferencedDocuments(message);
  if (refs.length === 0) return message;
  const lines = refs.map((doc) => `- ${doc.title} (documentId: ${doc.id})`);
  const context = `Referenced documents:\n${lines.join("\n")}\nUse these document IDs with tools when relevant.`;
  return `${message}\n\n${context}`;
}

function formatUserMessageForDisplay(message: string): string {
  return message.replace(/@\[([^\]]+)\]\(doc:[^)]+\)/g, "@$1");
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
  scrollToBottomIfNearBottom();
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

async function streamAssistantResponse(userMessage: string, responseStartIndex: number) {
  const assistantMessageIndex = { value: null as number | null };
  const thinkingMessageIndex = { value: null as number | null };

  await fetchStreamingCompletion({
    url: "/api/v1/chat/acp",
    sessionId: currentSessionId.value!,
    spaceId: currentSpaceId.value!,
    documentId: props.documentId || undefined,
    userMessage,
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
  clearPendingAttachments();
  closeMentionSuggestions();
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
  clearPendingAttachments();
  closeMentionSuggestions();
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
    await streamAssistantResponse(pendingUserMessage, responseStartIndex);
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
    scrollToBottom();
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
    void fetch("/api/v1/chat/acp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: {
          sessionId: currentSessionId.value,
          spaceId: currentSpaceId.value,
        },
      }),
    });
  }
  abortController?.abort();
  abortController = null;
}

async function sendMessage() {
  if (!canSend.value) return;

  const message = messageInput.value.trim();
  closeMentionSuggestions();
  const attachmentsToUpload = [...pendingAttachments.value];
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
      uploadedAttachments = await Promise.all(
        attachmentsToUpload.map(async (attachment) => {
          const result = await api.uploads.post(
            currentSpaceId.value,
            attachment.file,
            attachment.name,
            props.documentId || undefined,
          );
          return {
            key: result.key as string,
            url: result.url as string,
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            isImage: attachment.type.startsWith("image/"),
          };
        }),
      );
    } catch (error) {
      uploadError.value =
        error instanceof Error ? error.message : "Failed to upload attachments";
      isUploadingFiles.value = false;
      return;
    } finally {
      isUploadingFiles.value = false;
    }
  }

  const enrichedMessage = buildMessageWithDocumentReferences(message);
  const modelMessage = buildMessageWithAttachments(enrichedMessage, uploadedAttachments);
  const userDisplayText =
    formatUserMessageForDisplay(message) ||
    `Uploaded ${uploadedAttachments.length} attachment${uploadedAttachments.length > 1 ? "s" : ""}`;

  messages.value.push({
    role: "user",
    content: userDisplayText,
    timestamp: Date.now(),
    attachments: uploadedAttachments,
  });
  messageInput.value = "";
  clearPendingAttachments();
  scrollToBottom();

  isGenerating.value = true;
  abortController = new AbortController();
  const responseStartIndex = messages.value.length;

  try {
    await streamAssistantResponse(modelMessage, responseStartIndex);
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
    scrollToBottom();
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isNearBottom(): boolean {
  const el = messagesContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

/** Unconditional scroll — use for explicit user actions (send, load session, generation done). */
function scrollToBottom() {
  setTimeout(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  }, 50);
}

/** Conditional scroll — use during streaming so the user can freely scroll up mid-response. */
function scrollToBottomIfNearBottom() {
  nextTick(() => {
    if (messagesContainer.value && isNearBottom()) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
}

function scrollThinkingToBottom() {
  nextTick(() => {
    const container = messagesContainer.value;
    if (!container) return;
    const pres = container.querySelectorAll(".thinking-content");
    if (!pres.length) return;
    const lastPre = pres[pres.length - 1] as HTMLElement;
    lastPre.scrollTop = lastPre.scrollHeight;
    // Also keep the main container scrolled to bottom if the user hasn't scrolled up.
    if (isNearBottom()) {
      container.scrollTop = container.scrollHeight;
    }
  });
}

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = ({ text }: { text: string }) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderMarkdown(content: string): string {
  return marked.parse(content, {
    breaks: true,
    gfm: true,
    renderer: markdownRenderer,
  }) as string;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

Actions.register("ai-chat:toggle", {
  title: "AI Chat",
  icon: () => "sparkles",
  description: "Open AI chat to ask questions about this document",
  group: "document",
  run: async () => {
    toggleWindow("ai-chat", { side: "right", width: 380 });
  },
});

onMounted(() => {
  loadUIState();
  window.addEventListener("resize", updateMentionOverlayPosition);
  window.addEventListener("scroll", updateMentionOverlayPosition, true);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateMentionOverlayPosition);
  window.removeEventListener("scroll", updateMentionOverlayPosition, true);
  clearPendingAttachments();
  Actions.unregister("ai-chat:toggle");
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

            <!-- Sessions picker -->
            <div v-if="showSessionPicker" class="flex-1 overflow-y-auto px-3 py-4">
              <div class="flex items-center justify-between mb-3 px-1">
                <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wide">Recent conversations</p>
                <button
                  @click="startNewChat"
                  class="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium transition-colors"
                >
                  <div class="svg-icon w-3.5 h-3.5" v-html="plusThinIcon" />
                  New chat
                </button>
              </div>
        <div class="space-y-0.5">
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
              <p class="text-sm text-neutral-800 truncate">{{ session.title }}</p>
              <p class="text-xs mt-0.5">
                <template v-if="getSessionStatus(session) === 'generating'">
                  <span class="text-primary-500 font-medium">Generating response…</span>
                </template>
                <template v-else-if="getSessionStatus(session) === 'awaiting'">
                  <span class="text-amber-500 font-medium">Awaiting response</span>
                </template>
                <template v-else>
                  <span class="text-neutral-400">{{ formatSessionDate(session.updatedAt) }}</span>
                </template>
              </p>
            </div>

            <button
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
        class="flex-1 overflow-y-auto px-3 py-4 space-y-3 messages-container"
        @click="closeMentionSuggestions()"
        @dragover.prevent
        @drop="onDropFiles"
      >
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
            class="px-3 py-1 bg-neutral-100 text-neutral-600 rounded-full text-xs"
          >
            {{ message.content }}
          </div>
          <div
            v-else-if="message.role === 'status'"
            class="max-w-[85%] status-bubble rounded-xl px-3 py-2 shadow-sm"
          >
            <div class="text-[11px] uppercase tracking-wide status-bubble-label mb-1">Agent log</div>
            <pre class="text-xs leading-relaxed whitespace-pre-wrap font-mono">{{ message.content }}</pre>
          </div>
          <template v-else-if="message.role === 'thinking'">
            <div class="w-7 h-7 rounded-lg bg-neutral-100 border border-neutral-200 flex items-center justify-center shrink-0 mt-0.5">
              <div class="svg-icon w-4 h-4 text-neutral-500" v-html="thinkingIcon" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="bg-neutral-100 border border-neutral-200 rounded-xl overflow-hidden shadow-sm max-h-72 flex flex-col">
                <div class="px-3.5 py-2 border-b border-neutral-200 text-[11px] font-medium uppercase tracking-wide text-neutral-500 shrink-0">
                  Thinking
                </div>
                <pre class="px-3.5 py-3 text-xs leading-relaxed whitespace-pre-wrap font-mono text-neutral-700 overflow-y-auto flex-1 min-h-0 thinking-content">{{ message.content }}</pre>
              </div>
              <div class="mt-1.5 px-0.5 text-[11px] text-neutral-500">
                {{ new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                &nbsp;·&nbsp; Agent
              </div>
            </div>
          </template>
          <template v-else-if="message.role === 'assistant'">
            <!-- Robot avatar -->
            <div class="w-7 h-7 rounded-lg bg-primary-50 border border-primary-100 flex items-center justify-center shrink-0 mt-0.5">
              <div class="svg-icon w-4 h-4 text-primary-500" v-html="robotIcon" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="bg-neutral-10 border border-neutral-100 rounded-xl overflow-hidden shadow-sm">
                <div class="px-3.5 py-3 text-sm text-neutral-800 leading-relaxed markdown-content" v-html="renderMarkdown(message.content)"></div>
              </div>
              <!-- Timestamp + model + copy/refresh icons -->
              <div class="flex items-center justify-between mt-1.5 px-0.5">
                <span class="text-[11px] text-neutral-500">
                  {{ new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                  &nbsp;·&nbsp; Agent
                </span>
                <div class="flex items-center gap-1">
                  <button class="p-0.5 text-neutral-400 hover:text-neutral-600 transition-colors" title="Copy" @click="navigator.clipboard.writeText(message.content)">
                    <div class="svg-icon w-3.5 h-3.5" v-html="copyOutlineIcon" />
                  </button>
                </div>
              </div>
            </div>
          </template>
          <template v-else-if="message.role === 'tool'">
            <div class="w-7 h-7 rounded-lg tool-message-bg flex items-center justify-center shrink-0 mt-0.5">
              <div class="svg-icon w-4 h-4 tool-message-icon" v-html="linkChainIcon" />
            </div>
            <div class="flex-1 min-w-0">
              <button
                type="button"
                class="w-full text-left border tool-message-bg rounded-xl overflow-hidden shadow-sm cursor-pointer"
                @click="toggleToolMessageExpanded(message, index)"
              >
                <div class="px-3.5 py-2 border-b tool-message-header text-[11px] font-medium uppercase tracking-wide">
                  {{ message.toolPhase === 'call' ? 'Tool call' : 'Tool result' }}
                  <span v-if="message.toolName" class="normal-case tracking-normal font-semibold tool-message-name ml-1">
                    {{ message.toolName }}
                  </span>
                  <span
                    v-if="message.toolPhase === 'result'"
                    class="normal-case tracking-normal font-medium text-neutral-500 ml-2"
                  >
                    {{ isToolMessageExpanded(message, index) ? 'Collapse' : 'Expand' }}
                  </span>
                </div>
                <pre
                  class="px-3.5 py-3 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto transition-all"
                  :style="
                    message.toolPhase === 'result' && !isToolMessageExpanded(message, index)
                      ? { maxHeight: '12rem' }
                      : undefined
                  "
                  :class="message.isError ? 'text-red-700 tool-error-bg' : 'text-neutral-700'"
                >{{ formatToolPreview(message) }}</pre>
              </button>
              <div class="mt-1.5 px-0.5 text-[11px] text-neutral-500">
                {{ new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                &nbsp;·&nbsp; ACP
              </div>
            </div>
          </template>
          <div
            v-else
            class="max-w-[80%] bg-primary-600 text-white rounded-xl px-3.5 py-2.5 ml-auto"
          >
            <p class="text-sm whitespace-pre-wrap leading-relaxed">{{ message.content }}</p>
            <div v-if="message.attachments?.length" class="mt-2 space-y-1.5">
              <a
                v-for="attachment in message.attachments"
                :key="attachment.key"
                :href="attachment.url"
                target="_blank"
                rel="noopener noreferrer"
                class="block rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-xs hover:bg-white/15 transition-colors"
              >
                <span class="font-medium">{{ attachment.name }}</span>
                <span class="opacity-80 ml-1">({{ formatFileSize(attachment.size) }})</span>
              </a>
            </div>
          </div>
        </div>
        </template>

        <!-- Tool-executing indicator -->
        <div
          v-if="waitingState?.kind === 'tool_executing'"
          class="flex gap-2 justify-start animate-message-slide-in"
        >
          <div class="w-7 h-7 rounded-lg tool-message-bg flex items-center justify-center shrink-0 mt-0.5">
            <div class="svg-icon w-4 h-4 tool-message-icon" v-html="linkChainIcon" />
          </div>
          <div class="flex-1 min-w-0 tool-message-bg border border-neutral-200 rounded-xl overflow-hidden shadow-sm mt-0.5">
            <div class="px-3.5 py-2 border-b tool-message-header text-[11px] font-medium uppercase tracking-wide flex items-center gap-1.5">
              Running
              <span class="normal-case tracking-normal font-semibold tool-message-name">
                {{ waitingState.tool.toolName }}
              </span>
              <span class="ml-auto flex items-center gap-0.5">
                <span class="typing-dot" />
                <span class="typing-dot" style="animation-delay: 160ms" />
                <span class="typing-dot" style="animation-delay: 320ms" />
              </span>
            </div>
            <pre
              v-if="formatToolPreview(waitingState.tool)"
              class="px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap font-mono text-neutral-500 max-h-20 overflow-hidden"
            >{{ formatToolPreview(waitingState.tool) }}</pre>
          </div>
        </div>

        <!-- Generic waiting indicator (before first event, or model processing a tool result) -->
        <div
          v-else-if="waitingState?.kind === 'waiting'"
          class="flex gap-2 justify-start animate-message-slide-in"
        >
          <div class="w-7 h-7 rounded-lg bg-primary-50 border border-primary-100 flex items-center justify-center shrink-0 mt-0.5">
            <div class="svg-icon w-4 h-4 text-primary-500" v-html="robotIcon" />
          </div>
          <div class="flex items-center bg-neutral-10 border border-neutral-100 rounded-xl px-3.5 py-3 gap-1 mt-0.5">
            <span class="typing-dot" />
            <span class="typing-dot" style="animation-delay: 160ms" />
            <span class="typing-dot" style="animation-delay: 320ms" />
          </div>
        </div>
      </div>

      <!-- Toolbar -->
      <div v-if="!showSessionPicker" class="px-3 py-1.5 flex items-center gap-3 shrink-0 border-t border-neutral-100 bg-neutral-50">
        <button
          @click="startNewChat"
          :disabled="isGenerating"
          class="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="New chat"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="pencilSquareIcon" />
          New chat
        </button>
        <div class="flex-1"/>
        <button
          v-if="sessions.length > 0"
          @click="showSessionPicker = true"
          class="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
          title="Recent conversations"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="clockIcon" />
          History
        </button>
      </div>

      <!-- Input bar -->
      <div class="px-3 pb-3 pt-2 bg-neutral-10 border-t border-neutral-100 shrink-0">
        <div
          ref="mentionAnchorEl"
          class="px-3 py-2 bg-neutral-50 border border-neutral-100 rounded-xl"
          @dragover.prevent
          @drop="onDropFiles"
        >
          <input
            ref="fileInput"
            type="file"
            multiple
            class="hidden"
            @change="onFilesSelected"
          />
          <div
            v-if="pendingAttachments.length > 0"
            class="mb-2 flex flex-wrap gap-1.5"
          >
            <div
              v-for="attachment in pendingAttachments"
              :key="attachment.id"
              class="group flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-10 px-1.5 py-1"
            >
              <img
                v-if="attachment.previewUrl"
                :src="attachment.previewUrl"
                :alt="attachment.name"
                class="h-8 w-8 rounded object-cover"
              />
              <div v-else class="h-8 w-8 rounded bg-neutral-200 text-neutral-500 flex items-center justify-center text-[10px] font-semibold">
                FILE
              </div>
              <div class="min-w-0 max-w-36">
                <p class="truncate text-xs text-neutral-700">{{ attachment.name }}</p>
                <p class="text-[10px] text-neutral-500">{{ formatFileSize(attachment.size) }}</p>
              </div>
              <button
                type="button"
                class="text-neutral-400 hover:text-red-500 transition-colors"
                @click="removePendingAttachment(attachment.id)"
              >
                <div class="svg-icon w-3.5 h-3.5" v-html="closeSmallIcon" />
              </button>
            </div>
          </div>
          <div class="flex items-end gap-2">
          <button
            type="button"
            @click="openFilePicker"
            title="Attach files"
            class="shrink-0 text-neutral-400 hover:text-neutral-700 transition-colors mb-0.5"
          >
            <div class="svg-icon w-4 h-4" v-html="paperclipIcon" />
          </button>
          <textarea
            ref="messageInputEl"
            v-model="messageInput"
            @input="onMessageInput"
            @click="updateMentionSuggestions"
            @keyup="updateMentionSuggestions"
            @keydown="onMessageKeydown"
            @paste="onPasteFiles"
            rows="1"
            placeholder="Ask anything..."
            class="flex-1 bg-transparent text-sm text-neutral-800 placeholder-neutral-400 focus:outline-none resize-none max-h-40 leading-5"
            style="field-sizing: content"
          />
          <button
            v-if="isGenerating"
            @click="cancelGeneration"
            class="shrink-0 text-neutral-500 hover:text-red-500 transition-colors mb-0.5"
            title="Stop generating"
          >
            <div class="svg-icon w-4 h-4" v-html="stopIcon" />
          </button>
          <button
            v-else
            @click="sendMessage"
            :disabled="!canSend"
            class="shrink-0 text-neutral-500 hover:text-primary-500 disabled:opacity-40 transition-colors mb-0.5"
            title="Send (⌘↵)"
          >
            <div class="svg-icon w-4 h-4" v-html="sendPlaneIcon" />
          </button>
        </div>
          <p v-if="isUploadingFiles" class="mt-2 text-xs text-neutral-500">Uploading files...</p>
          <p v-if="uploadError" class="mt-2 text-xs text-red-600">{{ uploadError }}</p>
        </div>
      </div>

    </div>
  </DockedPanel>
  <Teleport to="body">
    <div
      v-if="mentionOpen"
      class="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-10 shadow-lg"
      :style="mentionOverlayStyle"
    >
      <div v-if="mentionLoading" class="px-2.5 py-2 text-xs text-neutral-500">
        Loading documents...
      </div>
      <button
        v-for="(suggestion, idx) in mentionSuggestions"
        :key="suggestion.id"
        type="button"
        class="flex w-full items-center justify-between px-2.5 py-2 text-left text-sm transition-colors"
        :class="idx === mentionActiveIndex ? 'bg-primary-50 text-primary-700' : 'hover:bg-neutral-50 text-neutral-700'"
        @mousedown.prevent="selectMention(suggestion)"
      >
        <span class="truncate font-medium">{{ suggestion.title }}</span>
        <span class="ml-2 truncate text-xs opacity-70">{{ suggestion.slug }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* Disable browser scroll anchoring so it doesn't fight our manual scroll management.
   We handle "stick to bottom" ourselves via scrollToBottomIfNearBottom(). */
.messages-container {
  overflow-anchor: none;
}

.animate-message-slide-in {
  animation: messageSlideIn 0.2s ease-out;
}

@keyframes messageSlideIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
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
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
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

details[open] .details-chevron { transform: rotate(90deg); }

.markdown-content :deep(p) { margin: 0.25rem 0; }
.markdown-content :deep(h1), .markdown-content :deep(h2), .markdown-content :deep(h3), .markdown-content :deep(h4) { margin: 0.5rem 0; font-weight: 600; }
.markdown-content :deep(ul) { margin: 0.25rem 0; padding-left: 1.25rem; list-style-type: disc; }
.markdown-content :deep(ol) { margin: 0.25rem 0; padding-left: 1.25rem; list-style-type: decimal; }
.markdown-content :deep(li) { margin: 0.125rem 0; }
.markdown-content :deep(code) {
  background: var(--color-primary-50);
  color: var(--color-primary-700);
  padding: 0.125rem 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.875em;
}
.markdown-content :deep(pre) {
  background: var(--color-neutral-900);
  color: var(--color-neutral-100);
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  margin: 0.5rem 0;
}
.markdown-content :deep(pre) :deep(code) { background: transparent; color: inherit; padding: 0; }
.markdown-content :deep(a) { color: var(--color-primary-600); text-decoration: underline; }
.markdown-content :deep(blockquote) { border-left: 3px solid var(--color-neutral-200); padding-left: 0.75rem; margin: 0.5rem 0; color: var(--color-neutral-500); }
.markdown-content :deep(strong) { font-weight: 600; }
.markdown-content :deep(hr) { margin: 0.75rem 0; border-color: var(--color-neutral-200); }

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
  background-color: #fffbeb;
  border-color: #fef3c7;
}

.tool-message-header {
  color: #b45309;
  border-color: rgba(254, 243, 199, 0.8);
}

.tool-message-name {
  color: #92400e;
}

.tool-message-icon {
  color: #d97706;
}

.tool-error-bg {
  background-color: rgba(254, 242, 242, 0.4);
}

@media (prefers-color-scheme: dark) {
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
    color: var(--color-neutral-600);
    border-color: var(--color-neutral-200);
  }
  .tool-message-name {
    color: var(--color-neutral-600);
  }
  .tool-message-icon {
    color: var(--color-neutral-500);
  }
  .tool-error-bg {
    background-color: rgba(33, 33, 33, 0.4);
  }
}

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
  color: var(--color-neutral-600);
  border-color: var(--color-neutral-200);
}
:root[data-theme="dark"] .tool-message-name {
  color: var(--color-neutral-600);
}
:root[data-theme="dark"] .tool-message-icon {
  color: var(--color-neutral-500);
}
:root[data-theme="dark"] .tool-error-bg {
  background-color: rgba(33, 33, 33, 0.4);
}
</style>
