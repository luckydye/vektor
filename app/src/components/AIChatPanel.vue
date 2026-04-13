<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from "vue";
import { marked } from "marked";
import { Actions } from "../utils/actions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { api } from "../api/client.ts";
import type { DocumentWithProperties } from "../api/ApiClient.ts";
import { fetchStreamingCompletion } from "./ai-chat/providers/shared.ts";
import type { ChatMessage, ChatStreamEvent } from "./ai-chat/types.ts";
import DockedPanel from "./DockedPanel.vue";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";
import {
  getSessionsForSpace,
  saveSession,
  deleteSession,
  type ChatSession,
  type UIMessage,
} from "../composeables/useChatSessions.ts";
import { normalizeTimestamp } from "../utils/utils.ts";

const props = defineProps({
  documentId: {
    type: String,
    default: "",
  },
});

const SYSTEM_PROMPT = `You are a helpful AI assistant integrated into a wiki/documentation system.`;

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

// Conversation history
const conversationHistory = ref<ChatMessage[]>([]);
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
  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
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
  if (!existing || existing.role !== "assistant") {
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

function appendToolEventMessage(event: Exclude<ChatStreamEvent, { type: "text" }>) {
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

function applyStreamEvent(
  event: ChatStreamEvent,
  assistantMessageIndex: { value: number | null },
) {
  if (event.type === "text") {
    appendAssistantMessageChunk(event.text, assistantMessageIndex);
  } else if (event.type === "status") {
    appendStatusMessage(event.text);
  } else {
    assistantMessageIndex.value = null;
    appendToolEventMessage(event);
  }
  scrollToBottom();
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
  const parts = [title, id ? `id: ${id}` : null, type ? `type: ${type}` : null].filter(Boolean);
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
      return summary ? `${index + 1}. ${summary.replace(/\n/g, " · ")}` : `${index + 1}. ${formatValuePreview(item)}`;
    });
    const extra = items.length > lines.length ? `\n+${items.length - lines.length} more` : "";
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
    if (typeof result === "string") {
      return result.trim() || "(no output)";
    }
    return formatValuePreview(result);
  }

  if (message.toolName === "get_document" || message.toolName === "get_current_document") {
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

async function sendWithProvider(message: string) {
  if (conversationHistory.value.length === 0) {
    if (!currentSpaceId.value) throw new Error("No space selected");
    conversationHistory.value = [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\nCurrent context:\n- spaceId: ${currentSpaceId.value}\n- documentId: ${props.documentId}`,
      },
    ];
  }

  conversationHistory.value.push({ role: "user", content: message });
  const assistantMessageIndex = { value: null as number | null };

  const { content } = await fetchStreamingCompletion({
    url: "/api/v1/chat/acp",
    model: "bash-agent",
    history: conversationHistory.value,
    body: {
      chatId: currentSessionId.value,
      spaceId: currentSpaceId.value,
      documentId: props.documentId || undefined,
    },
    onDelta: (text) => {
      appendAssistantMessageChunk(text, assistantMessageIndex);
      scrollToBottom();
    },
    onEvent: (event) => applyStreamEvent(event, assistantMessageIndex),
    signal: abortController?.signal,
  });

  conversationHistory.value.push({ role: "assistant", content });
}

// ── Session management ────────────────────────────────────────────────────────

async function loadSessions() {
  if (!currentSpaceId.value) return;
  sessions.value = await getSessionsForSpace(currentSpaceId.value);
}

watch(currentSpaceId, (id) => {
  if (id) loadSessions();
});

function startNewChat() {
  currentSessionId.value = null;
  messages.value = [];
  conversationHistory.value = [];
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
  conversationHistory.value = session.conversationHistory as ChatMessage[];
  showSessionPicker.value = false;
  scrollToBottom();
}

async function persistSession() {
  if (!currentSessionId.value) return;
  const session = sessions.value.find((s) => s.id === currentSessionId.value);
  if (!session) return;
  session.messages = messages.value;
  session.conversationHistory = conversationHistory.value;
  session.updatedAt = Date.now();
  await saveSession(session);
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
      conversationHistory.value = [];
    } else {
      startNewChat();
    }
  }
}

// ── Send message ──────────────────────────────────────────────────────────────

function cancelGeneration() {
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
    await sendWithProvider(modelMessage);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      conversationHistory.value.push({
        role: "assistant",
        content: collectAssistantText(responseStartIndex) || "(cancelled)",
      });
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
    abortController = null;
    isGenerating.value = false;
    scrollToBottom();
    await persistSession();
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function scrollToBottom() {
  setTimeout(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  }, 50);
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

onMounted(async () => {
  loadUIState();
  await loadSessions();
  window.addEventListener("resize", updateMentionOverlayPosition);
  window.addEventListener("scroll", updateMentionOverlayPosition, true);

  if (sessions.value.length > 0) {
    showSessionPicker.value = true;
  } else {
    messages.value.push({
      role: "assistant",
      content: "Hello! I'm here to help you with this document. Ask me anything!",
      timestamp: Date.now(),
    });
  }
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
        <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wide mb-3 px-1">Recent conversations</p>
        <div class="space-y-0.5">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="group flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-neutral-100 cursor-pointer transition-colors"
            @click="resumeSession(session)"
          >
            <div class="flex-1 min-w-0">
              <p class="text-sm text-neutral-800 truncate">{{ session.title }}</p>
              <p class="text-xs text-neutral-400 mt-0.5">{{ formatSessionDate(session.updatedAt) }}</p>
            </div>
            <button
              @click.stop="removeSession(session.id)"
              class="opacity-0 group-hover:opacity-100 p-1 text-neutral-400 hover:text-red-500 transition-all shrink-0"
              title="Delete"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Messages -->
      <div
        v-else
        ref="messagesContainer"
        class="flex-1 overflow-y-auto px-3 py-4 space-y-3"
        @click="closeMentionSuggestions()"
        @dragover.prevent
        @drop="onDropFiles"
      >
        <div
          v-for="(message, index) in messages"
          :key="index"
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
            class="max-w-[85%] bg-neutral-950 text-neutral-100 border border-neutral-800 rounded-xl px-3 py-2 shadow-sm"
          >
            <div class="text-[11px] uppercase tracking-wide text-neutral-400 mb-1">Agent log</div>
            <pre class="text-xs leading-relaxed whitespace-pre-wrap font-mono">{{ message.content }}</pre>
          </div>
          <template v-else-if="message.role === 'assistant'">
            <!-- Robot avatar -->
            <div class="w-7 h-7 rounded-lg bg-primary-50 border border-primary-100 flex items-center justify-center shrink-0 mt-0.5">
              <svg class="w-4 h-4 text-primary-500" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a2 2 0 012 2v1h3a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2h3V4a2 2 0 012-2zm-3 7a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zm-6 4h6v1H9v-1z"/>
              </svg>
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
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </template>
          <template v-else-if="message.role === 'tool'">
            <div class="w-7 h-7 rounded-lg bg-amber-50 border border-amber-100 flex items-center justify-center shrink-0 mt-0.5">
              <svg class="w-4 h-4 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.7 6.3a1 1 0 010 1.4l-1 1a4 4 0 005.7 5.6l1-1a1 1 0 011.4 1.5l-1 1a6 6 0 01-8.5-8.5l1-1a1 1 0 011.4 0z"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.3 17.7a1 1 0 010-1.4l1-1a4 4 0 00-5.7-5.6l-1 1a1 1 0 01-1.4-1.5l1-1a6 6 0 018.5 8.5l-1 1a1 1 0 01-1.4 0z"/>
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <button
                type="button"
                class="w-full text-left bg-amber-50 border border-amber-100 rounded-xl overflow-hidden shadow-sm cursor-pointer"
                @click="toggleToolMessageExpanded(message, index)"
              >
                <div class="px-3.5 py-2 border-b border-amber-100/80 text-[11px] font-medium uppercase tracking-wide text-amber-700">
                  {{ message.toolPhase === 'call' ? 'Tool call' : 'Tool result' }}
                  <span v-if="message.toolName" class="normal-case tracking-normal font-semibold text-amber-800 ml-1">
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
                  :class="message.isError ? 'text-red-700 bg-red-50/40' : 'text-neutral-700'"
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
      </div>

      <!-- Suggestion chips -->
      <div v-if="!showSessionPicker" class="px-3 py-2 flex gap-2 flex-wrap shrink-0 border-t border-neutral-100 bg-neutral-50">
        <button
          v-for="chip in ['Create pipeline', 'Error handling', 'Optimize', 'Add AI node']"
          :key="chip"
          class="px-3 py-1 text-xs text-neutral-700 bg-neutral-10 border border-neutral-100 rounded-full hover:bg-neutral-50 hover:border-neutral-200 transition-colors"
          @click="messageInput = chip"
        >
          {{ chip }}
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
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="flex items-end gap-2">
          <button
            v-if="sessions.length > 0"
            @click="showSessionPicker = true"
            title="Chat history"
            class="shrink-0 text-neutral-400 hover:text-neutral-600 transition-colors mb-0.5"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path stroke-linecap="round" d="M12 6v6l4 2"/>
            </svg>
          </button>
          <button
            type="button"
            @click="openFilePicker"
            title="Attach files"
            class="shrink-0 text-neutral-400 hover:text-neutral-700 transition-colors mb-0.5"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21.44 11.05l-8.49 8.49a5 5 0 01-7.07-7.07l8.49-8.49a3.5 3.5 0 014.95 4.95l-8.5 8.49a2 2 0 01-2.82-2.82l7.78-7.78"/>
            </svg>
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
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
          <button
            v-else
            @click="sendMessage"
            :disabled="!canSend"
            class="shrink-0 text-neutral-500 hover:text-primary-500 disabled:opacity-40 transition-colors mb-0.5"
            title="Send (⌘↵)"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/>
            </svg>
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
.animate-message-slide-in {
  animation: messageSlideIn 0.2s ease-out;
}

@keyframes messageSlideIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
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
</style>
