import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { type AIChatMessage, isUploadAborted } from "#api/client.ts";
import {
  type ChatAttachment,
  type ImageChatAttachment,
  useAIChat,
} from "#composeables/useAIChat.ts";
import { useChatSessionHandling } from "#composeables/useChatSessionHandling.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { t } from "#utils/lang.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { formatFileSize } from "#utils/utils.ts";
import "#editor/css/mentions.css";
import { AIChatMessages, type AIChatMessagesHandle } from "./AIChatMessages.tsx";
import { AIChatSessions } from "./AIChatSessions.tsx";
import { DockedPanel } from "./DockedPanel.tsx";
import { Icon } from "./Icon.tsx";
import { MessageInput, type MessageInputHandle } from "./MessageInput.tsx";

interface Props {
  documentId?: string;
}

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

export function AIChatPanel(props: Props) {
  const documentId = () => props.documentId ?? "";

  const { currentSpace, currentSpaceId } = useSpace();
  const {
    toggle: toggleWindow,
    close: closeWindow,
    windows: dockedWindows,
  } = useDockedWindows();
  const { uploadFiles } = useUploads();
  const isOpen = createMemo(() => dockedWindows().get("ai-chat")?.open ?? false);
  const [messageInput, setMessageInput] = createSignal("");
  const [messagesRef, setMessagesRef] = createSignal<AIChatMessagesHandle | null>(null);
  const [messages, setMessages] = createStore<AIChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = createSignal(false);
  const [messageInputEl, setMessageInputEl] = createSignal<MessageInputHandle | null>(
    null,
  );
  const [isUploadingFiles, setIsUploadingFiles] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");

  let reconnectSession = async (_pendingUserMessage: string) => {};

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
    refreshCurrentSession,
    getSessionStatus,
    startNewChat,
    resumeSession,
    createSession,
    removeSession,
  } = useChatSessionHandling({
    currentSpaceId,
    isActive: isOpen,
    messages: () => messages,
    setMessages,
    isGenerating,
    resetDraft: resetSessionDraft,
    scrollToBottom: () => messagesRef()?.scrollToBottom(),
    reconnectSession: (pendingUserMessage) => reconnectSession(pendingUserMessage),
  });

  const canSend = createMemo(() => !isGenerating() && !isUploadingFiles());

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
        (message || attachmentsToUpload[0]?.name || "New chat").slice(0, 60),
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

  const isAgentConfigured = createMemo(() => {
    const preferences = currentSpace()?.preferences;
    return !!preferences?.["ai:provider"] && !!preferences?.["ai:model"];
  });

  createEffect(
    on(isAgentConfigured, (configured) => {
      if (!configured) {
        if (isOpen()) closeWindow("ai-chat");
        return;
      }
      registerScopedAction("ai-chat:toggle", {
        title: t("AI Chat"),
        icon: () => "agent-chat",
        description: t("Open AI chat to ask questions about this document"),
        group: "document",
        run: async () => {
          toggleWindow("ai-chat", { side: "right", width: 380 });
        },
      });
    }),
  );

  return (
    <DockedPanel id="ai-chat" title="AI Assistant" defaultSide="right" defaultWidth={380}>
      <div class="flex h-full flex-col bg-neutral-50">
        <AIChatSessions
          sessions={sessions()}
          currentSessionId={currentSessionId()}
          showPicker={showSessionPicker()}
          isGenerating={isGenerating()}
          getSessionStatus={getSessionStatus}
          onUpdateShowPicker={setShowSessionPicker}
          onNewChat={startNewChat}
          onResume={resumeSession}
          onRemove={(session) => void removeSession(session.id)}
        />

        <Show when={!showSessionPicker()}>
          <AIChatMessages
            ref={setMessagesRef}
            messages={messages}
            isGenerating={isGenerating()}
            sessionStartedAt={sessionStartedAt()}
          />
        </Show>

        <div class="shrink-0 px-3 pt-2 pb-2">
          <div class="rounded-md border border-neutral-100 bg-neutral-10 px-3 py-2">
            <MessageInput
              ref={setMessageInputEl}
              value={messageInput()}
              onInput={setMessageInput}
              placeholder="Ask anything..."
              rows={3}
              autoGrow
              attachments
              mentions
              inlineDocumentReferences
              spaceId={currentSpaceId() ?? undefined}
              documentId={documentId()}
              disabled={!canSend()}
              isUploading={isUploadingFiles()}
              uploadError={uploadError()}
              onSubmit={() => void sendMessage()}
              actions={
                <Show
                  when={isGenerating()}
                  fallback={
                    <button
                      type="button"
                      onClick={() => void sendMessage()}
                      disabled={!canSend()}
                      class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 transition-colors hover:text-primary-500 disabled:opacity-40"
                      title="Send (↵)"
                    >
                      <Icon class="h-4 w-4" name="send-message" />
                    </button>
                  }
                >
                  <button
                    type="button"
                    onClick={cancelGeneration}
                    class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 transition-colors hover:text-red-500"
                    title="Stop generating"
                  >
                    <Icon class="h-4 w-4" name="stop" />
                  </button>
                </Show>
              }
            />
          </div>
        </div>
      </div>
    </DockedPanel>
  );
}
