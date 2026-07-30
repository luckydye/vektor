<script setup lang="ts">
import { formatFileSize } from "#utils/utils.ts";

defineOptions({ inheritAttrs: false });

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  type ChatAttachment,
  type ImageChatAttachment,
  useAIChat,
} from "#composeables/useAIChat.ts";
import { useChatSessionHandling } from "#composeables/useChatSessionHandling.ts";
import type { UIMessage } from "#composeables/useChatSessions.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import "#editor/css/mentions.css";
import { sendMessageIcon, stopIcon } from "#assets/icons.ts";
import AIChatMessages from "./AIChatMessages.vue";
import AIChatSessions from "./AIChatSessions.vue";
import DockedPanel from "./DockedPanel.vue";
import MessageInput from "./MessageInput.vue";

const props = defineProps({
  documentId: {
    type: String,
    default: "",
  },
});

type UploadedAttachment = ChatAttachment & {
  url: string;
};

const VISION_IMAGE_MEDIA_TYPES = new Set<ImageChatAttachment["mediaType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ── State ─────────────────────────────────────────────────────────────────────

const { currentSpace, currentSpaceId } = useSpace();
const {
  toggle: toggleWindow,
  close: closeWindow,
  windows: dockedWindows,
} = useDockedWindows();
const { uploadFiles } = useUploads();
const isOpen = computed(() => dockedWindows.value.get("ai-chat")?.open ?? false);
const messageInput = ref("");
const messagesRef = ref<InstanceType<typeof AIChatMessages> | null>(null);
const messages = ref<UIMessage[]>([]);
const isGenerating = ref(false);
const messageInputEl = ref<InstanceType<typeof MessageInput> | null>(null);
const isUploadingFiles = ref(false);
const uploadError = ref("");

let reconnectSession = async (_pendingUserMessage: string) => {};

function resetSessionDraft() {
  uploadError.value = "";
  messageInputEl.value?.clearAttachments();
}

const {
  currentSessionId,
  sessions,
  showSessionPicker,
  sessionStartedAt,
  refreshCurrentSession,
  getSessionStatus,
  startNewChat,
  resumeSession,
  createSession,
  removeSession,
} = useChatSessionHandling({
  currentSpaceId,
  messages,
  isGenerating,
  resetDraft: resetSessionDraft,
  scrollToBottom: () => messagesRef.value?.scrollToBottom(),
  reconnectSession: (pendingUserMessage) => reconnectSession(pendingUserMessage),
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

const {
  buildDocumentReferenceContext,
  completeResponse,
  cancelGeneration,
  reconnectSession: reconnectChatSession,
} = useAIChat({
  currentSessionId,
  currentSpaceId,
  documentId: () => props.documentId,
  messages,
  isGenerating,
  refreshCurrentSession,
  scrollToBottomIfFollowing: () => messagesRef.value?.scrollToBottomIfFollowing(),
  scrollThinkingToBottom: () => messagesRef.value?.scrollThinkingToBottom(),
});
reconnectSession = reconnectChatSession;

// ── Send message ──────────────────────────────────────────────────────────────

async function sendMessage() {
  if (!canSend.value) return;

  const message = messageInput.value.trim();
  const attachmentsToUpload = [...(messageInputEl.value?.pendingAttachments ?? [])];
  uploadError.value = "";

  showSessionPicker.value = false;

  if (!currentSessionId.value) {
    await createSession(
      (message || attachmentsToUpload[0]?.name || "New chat").slice(0, 60),
    );
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
          isImage: VISION_IMAGE_MEDIA_TYPES.has(
            attachment.type as ImageChatAttachment["mediaType"],
          ),
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

  messages.value.push({
    role: "user",
    content: userDisplayText,
    timestamp: Date.now(),
    attachments: uploadedAttachments,
  });
  messageInput.value = "";
  messageInputEl.value?.clearAttachments();
  messagesRef.value?.scrollToBottom();

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

// ── Utilities ─────────────────────────────────────────────────────────────────

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// The agent only works when the space has an AI provider configured, so the
// action stays unregistered (and out of the command palette) until it is. The
// provider lives in the space preferences the space payload already carries, so
// this works for every role that may use the agent — viewer included. The
// preference keys are owned by `db/aiConfig.ts`, which the client cannot import.
const isAgentConfigured = computed(() => {
  const preferences = currentSpace.value?.preferences;
  return !!preferences?.["ai:provider"] && !!preferences?.["ai:model"];
});

watch(
  isAgentConfigured,
  (configured) => {
    if (!configured) {
      Actions.unregister("ai-chat:toggle");
      // Persisted UI state can restore the panel in a space with no provider.
      if (isOpen.value) closeWindow("ai-chat");
      return;
    }
    Actions.register("ai-chat:toggle", {
      title: t("AI Chat"),
      icon: () => "agent-chat",
      description: t("Open AI chat to ask questions about this document"),
      group: "document",
      run: async () => {
        toggleWindow("ai-chat", { side: "right", width: 380 });
      },
    });
  },
  { immediate: true },
);

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
      <AIChatSessions
        :sessions="sessions"
        :current-session-id="currentSessionId"
        :show-picker="showSessionPicker"
        :is-generating="isGenerating"
        :get-session-status="getSessionStatus"
        @update:show-picker="showSessionPicker = $event"
        @new-chat="startNewChat"
        @resume="resumeSession"
        @remove="(session) => removeSession(session.id)"
      />

      <!-- Messages -->
      <AIChatMessages
        v-if="!showSessionPicker"
        ref="messagesRef"
        :messages="messages"
        :is-generating="isGenerating"
        :session-started-at="sessionStartedAt"
      />

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
                <div class="svg-icon w-4 h-4" v-html="sendMessageIcon" />
              </button>
            </template>
          </MessageInput>
        </div>
      </div>
    </div>
  </DockedPanel>
</template>
