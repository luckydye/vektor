import { createMemo, createSignal, For, Show } from "solid-js";
import type { AgentChat } from "#composeables/useAgentChat.ts";
import { AIChatMessages } from "./AIChatMessages.tsx";
import { AIChatSessions } from "./AIChatSessions.tsx";
import { Icon } from "./Icon.tsx";
import { MessageInput } from "./MessageInput.tsx";
import { RemoteScreen } from "./RemoteScreen.tsx";
import { RunnerPicker } from "./RunnerPicker.tsx";
import "#editor/css/mentions.css";

interface Props {
  chat: AgentChat;
  class?: string;
  /** Shared `view-transition-name` for the input box. */
  inputTransitionName?: string;
}

type PinnedScreen = {
  screen: NonNullable<AgentChat["messages"][number]["screen"]>;
  task: string;
};

export function AIChatConversation(props: Props) {
  const chat = props.chat;
  /** Remote sessions' screens stay pinned above the transcript, like a screen share. */
  const screens = createMemo(() => {
    // Each turn on a runner re-announces its session; one tile per session, labelled by the latest task.
    const bySession = new Map<string, PinnedScreen>();
    for (const message of chat.messages) {
      if (message.role === "screen" && message.screen) {
        bySession.set(message.screen.sessionId, {
          screen: message.screen,
          task: message.content,
        });
      }
    }
    return bySession;
  });
  const screenIds = createMemo(() => [...screens().keys()], [], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const [screenHeight, setScreenHeight] = createSignal(320);

  function resizeScreen(event: PointerEvent) {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = screenHeight();
    const move = (moved: PointerEvent) =>
      setScreenHeight(
        Math.min(window.innerHeight * 0.8, Math.max(120, startHeight + moved.clientY - startY)),
      );
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  return (
  <div class={`flex h-full min-h-0 flex-col bg-neutral-10 ${props.class ?? ""}`}>
    <Show when={screenIds().length && !chat.showSessionPicker()}>
      <div class="shrink-0 px-3 pt-3">
        <div class="flex gap-2" style={{ height: `${screenHeight()}px` }}>
          {/* Keyed by session id so a new response does not remount (and reload) the streams. */}
          <For each={screenIds()}>
            {(id) => {
              const entry = () => screens().get(id);
              return (
                <Show when={entry()}>
                  {(pinned) => <RemoteScreen screen={pinned().screen} task={pinned().task} />}
                </Show>
              );
            }}
          </For>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a drag handle, not a content separator */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize screen"
          class="group flex h-3 cursor-row-resize touch-none items-center justify-center"
          onPointerDown={resizeScreen}
        >
          <div class="h-1 w-10 rounded-full bg-neutral-200 transition-colors group-hover:bg-neutral-400" />
        </div>
      </div>
    </Show>
    <Show
      when={!chat.showSessionPicker()}
      fallback={
        <AIChatSessions
          sessions={chat.sessions()}
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
      <div
      class="overflow-hidden rounded-xl border border-neutral-200 bg-neutral-10 shadow-sm transition-colors focus-within:border-neutral-300"
      style={{ "view-transition-name": props.inputTransitionName }}
    >
      <div class="px-3 pt-2.5 pb-2">
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
                    class="flex h-7 pointer-coarse:h-9 pointer-coarse:w-9 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white transition-colors enabled:hover:bg-primary-700 disabled:bg-neutral-100 disabled:text-neutral-400"
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
      <Show when={chat.showRunnerPicker()}>
        <div class="flex items-center gap-2 border-neutral-100 border-t bg-neutral-50 px-3 py-2">
          <RunnerPicker
            runners={chat.agentRunners() ?? []}
            value={chat.chatNode()}
            onChange={chat.currentSessionId() ? undefined : chat.setChatNode}
            label="Run the agent on"
          />
        </div>
      </Show>
    </div>
    </div>
  </div>
  );
}
