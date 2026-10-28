import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import {
  type AIChatMessage,
  type AIChatSessionListEntry,
  isUploadAborted,
} from "#api/client.ts";
import {
  type ChatAttachment,
  type ImageChatAttachment,
  useAIChat,
} from "#composeables/useAIChat.ts";
import { useAvailableRunners } from "#composeables/useAvailableRunners.ts";
import { useChatSessionHandling } from "#composeables/useChatSessionHandling.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useAgentAvailable } from "#composeables/useIntegrationAIModel.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { Actions } from "#utils/actions.ts";
import { mentionsToText } from "#utils/markdown.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { formatFileSize } from "#utils/utils.ts";
import "#editor/css/mentions.css";
import { useTranslation } from "#composeables/useTranslation.ts";
import { AIChatMessages, type AIChatMessagesHandle } from "./AIChatMessages.tsx";
import { AIChatSessions } from "./AIChatSessions.tsx";
import { DockedPanel } from "./DockedPanel.tsx";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { MessageInput, type MessageInputHandle } from "./MessageInput.tsx";
import { RunnerPicker } from "./RunnerPicker.tsx";

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
  const t = useTranslation();

  const documentId = () => props.documentId ?? "";

  const { currentSpaceId } = useSpace();
  const {
    open,
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

  let reconnectSession = async () => {};

  function resetSessionDraft() {
    setUploadError("");
    messageInputEl()?.clearAttachments();
  }

  const {
    currentSessionId,
    sessions,
    visibleSessions,
    showJobSessions,
    setShowJobSessions,
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
    isActive: isOpen,
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
    createMemo(() => isOpen() && !currentSessionId()),
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

  const agentAvailable = useAgentAvailable();
  const isAgentConfigured = createMemo(() => agentAvailable() === true);

  onCleanup(
    Actions.subscribe("ai-chat:ask", (event) => {
      open("ai-chat", { side: "right", width: 380 });
      setMessageInput(event.detail as string);
      // A running turn belongs to the current session, so the question waits in the input.
      if (isGenerating()) return;
      startNewChat();
      void sendMessage();
    }),
  );
  onCleanup(
    Actions.subscribe("ai-chat:resume", (event) => {
      open("ai-chat", { side: "right", width: 380 });
      void resumeSession(event.detail as AIChatSessionListEntry);
    }),
  );
  onCleanup(
    Actions.subscribe("ai-chat:sessions", () => {
      open("ai-chat", { side: "right", width: 380 });
      setShowSessionPicker(true);
    }),
  );

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
        group: "document:view",
        order: 20,
        run: async () => {
          toggleWindow("ai-chat", { side: "right", width: 380 });
        },
      });
    }),
  );

  const contextUrl = () => {
    const spaceId = currentSpaceId();
    const sessionId = currentSessionId();
    if (!spaceId || !sessionId) return null;
    return `/api/v1/spaces/${encodeURIComponent(spaceId)}/ai-chat/sessions/${encodeURIComponent(sessionId)}/context`;
  };

  return (
    <DockedPanel
      id="ai-chat"
      title="Assistant"
      defaultSide="right"
      defaultWidth={380}
      swipeToOpen={isAgentConfigured()}
      actions={
        <>
          <Show when={sessions().length > 0}>
            <IconButton
              icon="activity"
              label="Chat history"
              tooltipPos="bottom"
              class={`pointer-coarse:h-9 pointer-coarse:w-9 ${showSessionPicker() ? "bg-neutral-100 text-neutral-900" : ""}`}
              onClick={() => setShowSessionPicker(!showSessionPicker())}
            />
          </Show>
          <Show when={contextUrl()}>
            {(url) => (
              <IconButton
                icon="source-code"
                label="Model context of the latest turn"
                tooltipPos="bottom"
                class="pointer-coarse:h-9 pointer-coarse:w-9"
                onClick={() => window.open(url(), "_blank", "noopener,noreferrer")}
              />
            )}
          </Show>
          <Show when={!showSessionPicker()}>
            <IconButton
              icon="edit-entry"
              label="New chat"
              tooltipPos="bottom"
              class="pointer-coarse:h-9 pointer-coarse:w-9"
              disabled={isGenerating()}
              onClick={startNewChat}
            />
          </Show>
          <span class="mx-1 h-4 w-px bg-neutral-200" />
        </>
      }
    >
      <div class="flex h-full flex-col bg-neutral-10">
        <Show
          when={!showSessionPicker()}
          fallback={
            <AIChatSessions
              sessions={visibleSessions()}
              showJobSessions={showJobSessions()}
              onUpdateShowJobSessions={setShowJobSessions}
              currentSessionId={currentSessionId()}
              getSessionStatus={getSessionStatus}
              onResume={resumeSession}
              onRemove={(session) => void removeSession(session.id)}
            />
          }
        >
          <AIChatMessages
            ref={setMessagesRef}
            messages={messages}
            isGenerating={isGenerating()}
            sessionStartedAt={sessionStartedAt()}
          />
        </Show>

        <div class="shrink-0 px-3 pb-3">
          <div class="rounded-xl border border-neutral-200 bg-neutral-10 px-3 pt-2.5 pb-2 shadow-sm transition-colors focus-within:border-neutral-300">
            <MessageInput
              ref={setMessageInputEl}
              value={messageInput()}
              onInput={setMessageInput}
              placeholder="Ask anything…"
              rows={2}
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
                <div class="flex min-w-0 items-center gap-1">
                  <Show when={showRunnerPicker()}>
                    <RunnerPicker
                      runners={agentRunners() ?? []}
                      value={chatNode()}
                      onChange={currentSessionId() ? undefined : setChatNode}
                      label="Run the agent on"
                    />
                  </Show>
                  <Show
                    when={isGenerating()}
                    fallback={
                      <button
                        type="button"
                        onClick={() => void sendMessage()}
                        disabled={
                          !canSend() ||
                          (!messageInput().trim() &&
                            !messageInputEl()?.pendingAttachments().length)
                        }
                        class="flex h-7 pointer-coarse:h-9 pointer-coarse:w-9 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white transition-colors enabled:hover:bg-primary-700 disabled:opacity-30"
                        title="Send (↵)"
                      >
                        <Icon class="h-3.5 w-3.5" name="send-message" />
                      </button>
                    }
                  >
                    <button
                      type="button"
                      onClick={cancelGeneration}
                      class="flex h-7 pointer-coarse:h-9 pointer-coarse:w-9 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-10 transition-colors hover:bg-neutral-900"
                      title="Stop generating"
                    >
                      <Icon class="h-3 w-3" name="stop" />
                    </button>
                  </Show>
                </div>
              }
            />
          </div>
        </div>
      </div>
    </DockedPanel>
  );
}
