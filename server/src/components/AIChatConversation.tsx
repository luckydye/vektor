import { Show } from "solid-js";
import type { AgentChat } from "#composeables/useAgentChat.ts";
import { AIChatMessages } from "./AIChatMessages.tsx";
import { AIChatSessions } from "./AIChatSessions.tsx";
import { Icon } from "./Icon.tsx";
import { MessageInput } from "./MessageInput.tsx";
import { RunnerPicker } from "./RunnerPicker.tsx";
import "#editor/css/mentions.css";

interface Props {
  chat: AgentChat;
  class?: string;
}

export function AIChatConversation(props: Props) {
  const chat = props.chat;
  return (
  <div class={`flex h-full min-h-0 flex-col bg-neutral-10 ${props.class ?? ""}`}>
    <Show
      when={!chat.showSessionPicker()}
      fallback={
        <AIChatSessions
          sessions={chat.visibleSessions()}
          showJobSessions={chat.showJobSessions()}
          onUpdateShowJobSessions={chat.setShowJobSessions}
          currentSessionId={chat.currentSessionId()}
          getSessionStatus={chat.getSessionStatus}
          onResume={chat.resumeSession}
          onRemove={(session) => void chat.removeSession(session.id)}
        />
      }
    >
      <AIChatMessages
        ref={chat.setMessagesRef}
        messages={chat.messages}
        isGenerating={chat.isGenerating()}
        sessionStartedAt={chat.sessionStartedAt()}
      />
    </Show>

    <div class="shrink-0 px-3 pb-3">
      <div class="rounded-xl border border-neutral-200 bg-neutral-10 px-3 pt-2.5 pb-2 shadow-sm transition-colors focus-within:border-neutral-300">
        <MessageInput
          ref={chat.setMessageInputEl}
          value={chat.messageInput()}
          onInput={chat.setMessageInput}
          placeholder="Ask anything…"
          rows={2}
          autoGrow
          attachments
          mentions
          inlineDocumentReferences
          spaceId={chat.currentSpaceId() ?? undefined}
          documentId={chat.documentId()}
          disabled={!chat.canSend()}
          isUploading={chat.isUploadingFiles()}
          uploadError={chat.uploadError()}
          onSubmit={() => void chat.sendMessage()}
          actions={
            <div class="flex min-w-0 items-center gap-1">
              <Show when={chat.showRunnerPicker()}>
                <RunnerPicker
                  runners={chat.agentRunners() ?? []}
                  value={chat.chatNode()}
                  onChange={chat.currentSessionId() ? undefined : chat.setChatNode}
                  label="Run the agent on"
                />
              </Show>
              <Show
                when={chat.isGenerating()}
                fallback={
                  <button
                    type="button"
                    onClick={() => void chat.sendMessage()}
                    disabled={
                      !chat.canSend() ||
                      (!chat.messageInput().trim() &&
                        !chat.messageInputEl()?.pendingAttachments().length)
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
                  onClick={chat.cancelGeneration}
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
  );
}
