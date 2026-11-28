import { type Accessor, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  type AIChatMessage,
  api,
  type ChatMessageRow,
  isUploadAborted,
} from "#api/client.ts";
import type { AIChatMessagesHandle } from "#components/AIChatMessages.tsx";
import type { MessageInputHandle } from "#components/MessageInput.tsx";
import {
  type ChatAttachment,
  type ImageChatAttachment,
  useAIChat,
} from "#composeables/useAIChat.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { formatFileSize } from "#utils/utils.ts";

const PAGE_SIZE = 100;

type UploadedAttachment = ChatAttachment & { url: string };

const VISION_IMAGE_MEDIA_TYPES = new Set<ImageChatAttachment["mediaType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function buildAttachmentContext(attachments: UploadedAttachment[]): string {
  if (attachments.length === 0) return "";
  const fileLines = attachments.map((file) => {
    if (file.isImage) {
      return `- ${file.name} (${file.type || "unknown"}, ${formatFileSize(file.size)}): included directly as an image input`;
    }
    return `- ${file.name} (${file.type || "unknown"}, ${formatFileSize(file.size)}): ${file.url}`;
  });
  return `Attached files:\n${fileLines.join("\n")}\nUse these files when relevant.`;
}

/** `buildUrl` → "Build url", `failed_tests` → "Failed tests", `pr` → "PR". */
function fieldLabel(key: string): string {
  // A key of two letters is an abbreviation: `pr`, `id`.
  if (/^[a-z]{1,2}$/i.test(key)) return key.toUpperCase();
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const MAX_FIELD_CHARS = 80;

function fieldValue(value: unknown): string {
  const text =
    value === null || typeof value !== "object"
      ? String(value)
      : Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")
        ? value.join(", ")
        : JSON.stringify(value);
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
}

/** An event's payload as labelled fields, the way properties read. */
export function eventFields(data: unknown): Array<{ label: string; value: string }> {
  if (data === undefined) return [];
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [{ label: "Data", value: fieldValue(data) }];
  }
  return Object.entries(data).map(([key, value]) => ({
    label: fieldLabel(key),
    value: fieldValue(value),
  }));
}

/**
 * A session's log rows as the transcript draws them: an assistant row's tool
 * calls become tool messages of their own, paired with their results by id.
 */
export function rowsToMessages(rows: ChatMessageRow[]): AIChatMessage[] {
  return rows.flatMap((row): AIChatMessage[] => {
    const timestamp = row.createdAt;
    const { metadata } = row;
    if (row.role === "user") {
      return [
        {
          role: "user",
          content: row.content,
          timestamp,
          seq: row.seq,
          authorId: row.authorId,
          attachments: metadata.attachments,
          eventFields: eventFields(metadata.event?.data),
          quiet: metadata.quiet,
        },
      ];
    }
    if (row.role === "tool") {
      return [
        {
          role: "tool",
          content: row.content,
          timestamp,
          seq: row.seq,
          toolName: metadata.toolName,
          toolCallId: metadata.tool_call_id,
          toolPhase: "result",
          isError: metadata.isError ?? false,
        },
      ];
    }
    return [
      // The model's reasoning, logged with the answer it led to.
      ...(metadata.thinking?.trim()
        ? [
            {
              role: "thinking" as const,
              content: metadata.thinking,
              timestamp,
              seq: row.seq,
            },
          ]
        : []),
      ...(row.content.trim()
        ? [
            {
              role: "assistant" as const,
              content: row.content,
              timestamp,
              seq: row.seq,
              isError: metadata.isError,
            },
          ]
        : []),
      ...(metadata.tool_calls ?? []).map((call) => ({
        role: "tool" as const,
        content: call.function.arguments,
        timestamp,
        toolName: call.function.name,
        toolCallId: call.id,
        toolPhase: "call" as const,
        isError: false,
      })),
    ];
  });
}

export type ChatSessionHandle = ReturnType<typeof useChatSession>;

/**
 * One chat session's transcript and composer: its rows, the round streaming
 * into it, and posting. Another viewer's round is followed when the session
 * starts running.
 */
export function useChatSession(options: {
  sessionId: Accessor<string | null>;
  /** Whether a round is running, as the session list last said. */
  running: Accessor<boolean>;
  /** The viewer, whose posts show at once. */
  currentUserId: Accessor<string | null>;
}) {
  const { currentSpaceId } = useSpace();
  const { uploadFiles } = useUploads();
  const [messages, setMessages] = createStore<AIChatMessage[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [isGenerating, setIsGenerating] = createSignal(false);
  const [messageInput, setMessageInput] = createSignal("");
  const [messagesRef, setMessagesRef] = createSignal<AIChatMessagesHandle | null>(null);
  const [messageInputEl, setMessageInputEl] = createSignal<MessageInputHandle | null>(
    null,
  );
  const [isUploadingFiles, setIsUploadingFiles] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");

  /**
   * Replaces the transcript with the newest page of the log. `unlessStreaming`
   * drops the page if a round began streaming in meanwhile, which it would wipe.
   */
  async function load(unlessStreaming = false) {
    const spaceId = currentSpaceId();
    const sessionId = options.sessionId();
    if (!spaceId || !sessionId) return;
    const page = await api.chatSessions.messages(spaceId, sessionId, { limit: PAGE_SIZE });
    // Switched to another session meanwhile.
    if (options.sessionId() !== sessionId) return;
    if (unlessStreaming && isGenerating()) return;
    setMessages(reconcile(rowsToMessages(page.messages)));
    setHasMore(page.hasMore);
    // Replacing the rows briefly changes the height; keep a reader who was
    // following at the bottom rather than wherever the scroll lands.
    messagesRef()?.scrollToBottomIfFollowing();
  }

  async function loadOlder() {
    const spaceId = currentSpaceId();
    const sessionId = options.sessionId();
    const first = messages.find((message) => message.seq !== undefined)?.seq;
    if (!spaceId || !sessionId || first === undefined) return;
    const page = await api.chatSessions.messages(spaceId, sessionId, {
      before: first,
      limit: PAGE_SIZE,
    });
    if (options.sessionId() !== sessionId) return;
    setMessages((list) => [...rowsToMessages(page.messages), ...list]);
    setHasMore(page.hasMore);
  }

  const { buildDocumentReferenceContext, completeResponse, cancelGeneration, reconnectSession } =
    useAIChat({
      currentSessionId: options.sessionId,
      currentSpaceId,
      documentId: () => "",
      messages: () => messages,
      setMessages,
      isGenerating,
      setIsGenerating,
      refreshCurrentSession: load,
      scrollToBottomIfFollowing: () => messagesRef()?.scrollToBottomIfFollowing(),
      scrollThinkingToBottom: () => messagesRef()?.scrollThinkingToBottom(),
    });

  /** Shows what was posted, then streams the round answering it. */
  async function follow() {
    if (isGenerating()) return;
    await load();
    await reconnectSession();
  }

  createEffect(
    on(options.sessionId, (sessionId) => {
      setMessages([]);
      setHasMore(false);
      setMessageInput("");
      setUploadError("");
      if (!sessionId) return;
      const running = untrack(options.running);
      void (running ? follow() : load()).then(() => messagesRef()?.scrollToBottom());
    }),
  );

  // Someone else's round; the viewer's own is streaming already.
  createEffect(
    on(
      options.running,
      (running) => {
        if (isGenerating()) return;
        void (running ? follow() : load());
      },
      { defer: true },
    ),
  );

  // Rows that start no round, like quiet events. Any chat event reloads: they
  // coalesce per topic, so which session one names cannot be relied on.
  useSync(currentSpaceId, [realtimeTopics.chat], () => {
    if (!isGenerating() && options.sessionId()) void load(true);
  });

  const canSend = createMemo(() => !isGenerating() && !isUploadingFiles());

  async function sendMessage() {
    if (!canSend()) return;
    const spaceId = currentSpaceId();
    if (!spaceId) return;

    const message = messageInput().trim();
    const attachmentsToUpload = [...(messageInputEl()?.pendingAttachments() ?? [])];
    setUploadError("");

    let uploadedAttachments: UploadedAttachment[] = [];
    if (attachmentsToUpload.length > 0) {
      setIsUploadingFiles(true);
      try {
        const results = await uploadFiles(
          attachmentsToUpload.map((attachment) => attachment.file),
          { spaceId, errorToast: false },
        );
        uploadedAttachments = results.map((result, index) => {
          const attachment = attachmentsToUpload[index];
          return {
            key: result.key as string,
            url: result.url as string,
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            isImage: VISION_IMAGE_MEDIA_TYPES.has(
              attachment.type as ImageChatAttachment["mediaType"],
            ),
          };
        });
      } catch (error) {
        if (!isUploadAborted(error)) {
          setUploadError(
            error instanceof Error ? error.message : "Failed to upload attachments",
          );
        }
        return;
      } finally {
        setIsUploadingFiles(false);
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
    const imageAttachments: ImageChatAttachment[] = uploadedAttachments.flatMap(
      (attachment) =>
        attachment.isImage
          ? [
              {
                key: attachment.key,
                mediaType: attachment.type as ImageChatAttachment["mediaType"],
              },
            ]
          : [],
    );

    setMessages(messages.length, {
      role: "user",
      content: userDisplayText,
      timestamp: Date.now(),
      authorId: options.currentUserId(),
      attachments: uploadedAttachments,
    });
    setMessageInput("");
    messageInputEl()?.clearAttachments();
    messagesRef()?.scrollToBottom();

    await completeResponse(
      userDisplayText,
      additionalContext,
      imageAttachments,
      uploadedAttachments.map(({ key, name, type, size, isImage }) => ({
        key,
        name,
        type,
        size,
        isImage,
      })),
    );
  }

  return {
    currentSpaceId,
    sessionId: options.sessionId,
    messages,
    hasMore,
    loadOlder,
    isGenerating,
    messageInput,
    setMessageInput,
    setMessagesRef,
    messageInputEl,
    setMessageInputEl,
    isUploadingFiles,
    uploadError,
    canSend,
    sendMessage,
    cancelGeneration,
  };
}
