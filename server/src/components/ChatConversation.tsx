import { createMemo, createSignal, For, Show } from "solid-js";
import type { ChatAuthor } from "#composeables/useBotChannels.ts";
import type { ChatSessionHandle } from "#composeables/useChatSession.ts";
import { usePersistedState } from "#composeables/usePersistedState.ts";
import { AIChatMessages, type RoleProposals } from "./AIChatMessages.tsx";
import { Icon } from "./Icon.tsx";
import { MessageInput } from "./MessageInput.tsx";
import { RemoteScreen } from "./RemoteScreen.tsx";
import "#editor/css/mentions.css";

interface Props {
  chat: ChatSessionHandle;
  class?: string;
  placeholder: string;
  emptyTitle: string;
  emptyHint: string;
  /** Why the viewer cannot post here; unset lets them. */
  readonlyReason?: string;
  bot?: { name: string; avatar: string | null };
  authorOf?: (authorId: string) => ChatAuthor | undefined;
  threadOf?: (seq: number) => { messageCount?: number } | undefined;
  onOpenThread?: (seq: number) => void;
  /** The bot's name while it answers, for the line under the composer. */
  typing?: string;
  roleProposals?: RoleProposals;
}

type PinnedScreen = {
  /** Changes every time a turn announces its screen, so the stream reconnects. */
  key: string;
  screen: NonNullable<ChatSessionHandle["messages"][number]["screen"]>;
  task: string;
};

/** A session's transcript with its composer, and any remote screens pinned above. */
export function ChatConversation(props: Props) {
  const chat = () => props.chat;
  const [endedScreens, setEndedScreens] = createSignal<ReadonlySet<string>>(new Set());
  /** Per chat, so a conversation that does not need the screen stays uncluttered. */
  const screensHidden = usePersistedState({
    key: () => {
      const sessionId = chat().sessionId();
      return sessionId ? `chat-screens-hidden:${sessionId}` : null;
    },
    fallback: false,
  });
  /** Remote sessions' screens stay pinned above the transcript, like a screen share. */
  const screens = createMemo(() => {
    // Each turn on a runner re-announces its session; one tile per session, labelled by the latest task.
    const bySession = new Map<string, PinnedScreen>();
    for (const message of chat().messages) {
      if (message.role === "screen" && message.screen) {
        bySession.set(message.screen.sessionId, {
          key: `${message.screen.sessionId}:${message.timestamp}`,
          screen: message.screen,
          task: message.content,
        });
      }
    }
    const ended = endedScreens();
    return new Map([...bySession].filter(([, entry]) => !ended.has(entry.key)));
  });
  const screenKeys = createMemo(
    () => [...screens().values()].map((entry) => entry.key),
    [],
    {
      equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
    },
  );
  const screensByKey = createMemo(
    () => new Map([...screens().values()].map((entry) => [entry.key, entry])),
  );
  /** Call-tile layout: two side by side, then a square grid as more screens join. */
  const screenGrid = createMemo(() => {
    const count = screenKeys().length;
    const columns = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
    return { columns, rows: Math.ceil(count / columns) };
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
      <Show when={screenKeys().length}>
        <div class="shrink-0 px-3 pt-3">
          <Show
            when={screensHidden.value()}
            fallback={
              <>
                <div
                  class="relative rounded-xl bg-neutral-900 p-2 shadow-sm"
                  style={{ height: `${screenHeight()}px` }}
                >
                  <button
                    type="button"
                    class="absolute top-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white/70 backdrop-blur transition-colors hover:bg-black/70 hover:text-white"
                    title="Hide screens"
                    aria-label="Hide screens"
                    onClick={() => screensHidden.commit(true)}
                  >
                    <Icon class="h-4 w-4" name="chevron-down" />
                  </button>
                  <div
                    class="grid h-full gap-2"
                    style={{
                      "grid-template-columns": `repeat(${screenGrid().columns}, minmax(0, 1fr))`,
                      "grid-template-rows": `repeat(${screenGrid().rows}, minmax(0, 1fr))`,
                    }}
                  >
                    {/* Keyed by announcement, so a new screen on the same session reconnects. */}
                    <For each={screenKeys()}>
                      {(key) => {
                        const entry = () => screensByKey().get(key);
                        return (
                          <Show when={entry()}>
                            {(pinned) => (
                              <RemoteScreen
                                screen={pinned().screen}
                                task={pinned().task}
                                onEnded={() =>
                                  setEndedScreens((previous) => new Set(previous).add(key))
                                }
                              />
                            )}
                          </Show>
                        );
                      }}
                    </For>
                  </div>
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
              </>
            }
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-left text-size-small text-white/70 transition-colors hover:bg-neutral-800 hover:text-white"
              onClick={() => screensHidden.commit(false)}
            >
              <Icon class="h-3.5 w-3.5" name="chevron-right-small" />
              Show {screenKeys().length === 1 ? "screen" : `${screenKeys().length} screens`}
            </button>
          </Show>
        </div>
      </Show>

      <AIChatMessages
        ref={chat().setMessagesRef}
        messages={chat().messages}
        isGenerating={chat().isGenerating()}
        sessionStartedAt={null}
        emptyTitle={props.emptyTitle}
        emptyHint={props.emptyHint}
        bot={props.bot}
        authorOf={props.authorOf}
        threadOf={props.threadOf}
        onOpenThread={props.onOpenThread}
        onLoadOlder={chat().hasMore() ? () => void chat().loadOlder() : undefined}
        roleProposals={props.roleProposals}
      />

      <div class="mx-auto w-full max-w-[56rem] shrink-0 px-4">
        <Show
          when={!props.readonlyReason}
          fallback={
            <div class="rounded-lg bg-neutral-100 px-4 py-3 text-center text-neutral-500 text-size-small">
              {props.readonlyReason}
            </div>
          }
        >
          <div class="overflow-hidden rounded-lg bg-neutral-100 transition-colors focus-within:bg-neutral-50 focus-within:ring-1 focus-within:ring-neutral-200">
            <div class="px-3 pt-2.5 pb-2">
              <MessageInput
                ref={chat().setMessageInputEl}
                value={chat().messageInput()}
                onInput={chat().setMessageInput}
                placeholder={props.placeholder}
                rows={2}
                autoGrow
                attachments
                mentions
                inlineDocumentReferences
                spaceId={chat().currentSpaceId() ?? undefined}
                disabled={!chat().canSend()}
                isUploading={chat().isUploadingFiles()}
                uploadError={chat().uploadError()}
                onSubmit={() => void chat().sendMessage()}
                actions={
                  <div class="flex min-w-0 items-center gap-1">
                    <Show
                      when={chat().isGenerating()}
                      fallback={
                        <button
                          type="button"
                          onClick={() => void chat().sendMessage()}
                          disabled={
                            !chat().canSend() ||
                            (!chat().messageInput().trim() &&
                              !chat().messageInputEl()?.pendingAttachments().length)
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
                        onClick={chat().cancelGeneration}
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
        </Show>
        {/* Reserved even when empty, so the composer does not jump. */}
        <div class="flex h-6 items-center gap-1.5 text-neutral-500 text-size-extra-small">
          <Show when={props.typing}>
            <span class="flex items-center gap-0.5 [&>.typing-dot]:h-1 [&>.typing-dot]:w-1">
              <span class="typing-dot" />
              <span class="typing-dot" style={{ "animation-delay": "160ms" }} />
              <span class="typing-dot" style={{ "animation-delay": "320ms" }} />
            </span>
            <span>
              <span class="font-semibold">{props.typing}</span> is answering…
            </span>
          </Show>
        </div>
      </div>
    </div>
  );
}
