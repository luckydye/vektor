import { createMemo, createSignal, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { type AIChatMessage, isUploadAborted } from "#api/client.ts";
import {
  type ChatAttachment,
  type ImageChatAttachment,
  useAIChat,
} from "#composeables/useAIChat.ts";
import { useAvailableRunners } from "#composeables/useAvailableRunners.ts";
import { useChatSessionHandling } from "#composeables/useChatSessionHandling.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { mentionsToText } from "#utils/markdown.ts";
import { formatFileSize } from "#utils/utils.ts";
import type { AIChatMessagesHandle } from "#components/AIChatMessages.tsx";
import type { MessageInputHandle } from "#components/MessageInput.tsx";

type UploadedAttachment = ChatAttachment & {
  url: string;
};

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
      return [
        `- ${file.name} (${file.type || "unknown"}, ${formatFileSize(file.size)}):`,
        " included directly as an image input",
      ].join("");
    }
    return `- ${file.name} (${file.type || "unknown"}, ${formatFileSize(file.size)}): ${file.url}`;
  });
  return `Attached files:\n${fileLines.join("\n")}\nUse these files when relevant.`;
}

export type AgentChat = ReturnType<typeof useAgentChat>;

export function useAgentChat(options: {
  documentId: Accessor<string>;
  isActive: Accessor<boolean>;
}) {
  const documentId = options.documentId;
  const { currentSpaceId } = useSpace();
  const { uploadFiles } = useUploads();
  const [messageInput, setMessageInput] = createSignal("");
  const [messagesRef, setMessagesRef] = createSignal<AIChatMessagesHandle | null>(null);
  const [messages, setMessages] = createStore<AIChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = createSignal(false);
  const [messageInputEl, setMessageInputEl] = createSignal<MessageInputHandle | null>(
    null,
  );
  const [isUploadingFiles, setIsUploadingFiles] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");

  let reconnectSession = async () => {};

  function resetSessionDraft() {
    setUploadError("");
    messageInputEl()?.clearAttachments();
  }

  const {
    currentSessionId,
    sessions,
    showSessionPicker,
    setShowSessionPicker,
    sessionStartedAt,
    chatNode,
    setChatNode,
    refreshCurrentSession,
    getSessionStatus,
    startNewChat,
    resumeSession,
    createSession,
    removeSession,
  } = useChatSessionHandling({
    currentSpaceId,
    isActive: options.isActive,
    messages: () => messages,
    setMessages,
    isGenerating,
    resetDraft: resetSessionDraft,
    scrollToBottom: () => messagesRef()?.scrollToBottom(),
    reconnectSession: () => reconnectSession(),
  });

  const canSend = createMemo(() => !isGenerating() && !isUploadingFiles());
  // Where a chat runs is chosen before its first message, then fixed.
  const agentRunners = useAvailableRunners(
    "agents",
    createMemo(() => options.isActive() && !currentSessionId()),
  );
  const showRunnerPicker = createMemo(() =>
    currentSessionId() ? !!chatNode() : !!agentRunners()?.length,
  );

  const {
    buildDocumentReferenceContext,
    completeResponse,
    cancelGeneration,
    reconnectSession: reconnectChatSession,
  } = useAIChat({
    currentSessionId,
    currentSpaceId,
    documentId,
    messages: () => messages,
    setMessages,
    isGenerating,
    setIsGenerating,
    refreshCurrentSession,
    scrollToBottomIfFollowing: () => messagesRef()?.scrollToBottomIfFollowing(),
    scrollThinkingToBottom: () => messagesRef()?.scrollThinkingToBottom(),
  });
  reconnectSession = reconnectChatSession;

  async function sendMessage() {
    if (!canSend()) return;

    const message = messageInput().trim();
    const attachmentsToUpload = [...(messageInputEl()?.pendingAttachments() ?? [])];
    setUploadError("");

    setShowSessionPicker(false);

    if (!currentSessionId()) {
      await createSession(
        (mentionsToText(message) || attachmentsToUpload[0]?.name || "New chat").slice(
          0,
          60,
        ),
      );
    }

    let uploadedAttachments: UploadedAttachment[] = [];
    if (attachmentsToUpload.length > 0) {
      const spaceId = currentSpaceId();
      if (!spaceId) {
        setUploadError("No active space selected");
        return;
      }
      setIsUploadingFiles(true);
      try {
        const results = await uploadFiles(
          attachmentsToUpload.map((attachment) => attachment.file),
          {
            spaceId,
            documentId: documentId() || undefined,
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
        setIsUploadingFiles(false);
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
        VISION_IMAGE_MEDIA_TYPES.has(attachment.type as ImageChatAttachment["mediaType"])
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
    documentId,
    currentSpaceId,
    messageInput,
    setMessageInput,
    setMessagesRef,
    messages,
    isGenerating,
    setMessageInputEl,
    messageInputEl,
    isUploadingFiles,
    uploadError,
    currentSessionId,
    sessions,
    showSessionPicker,
    setShowSessionPicker,
    sessionStartedAt,
    chatNode,
    setChatNode,
    getSessionStatus,
    startNewChat,
    resumeSession,
    removeSession,
    canSend,
    agentRunners,
    showRunnerPicker,
    cancelGeneration,
    sendMessage,
  };
}
