import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import type { ChatSession } from "#api/client.ts";
import { BotAvatar } from "#components/AIChatMessages.tsx";
import { BotEditorDialog } from "#components/BotEditorDialog.tsx";
import { ChatConversation } from "#components/ChatConversation.tsx";
import { IconButton } from "#components/IconButton.tsx";
import {
  useAgentRunnerAgents,
  useBotActions,
  useBotChannels,
  useChatPeople,
  useChatThreads,
} from "#composeables/useBotChannels.ts";
import { useChatSession } from "#composeables/useChatSession.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

/** Where a bot runs, and whether it can answer from there. */
function runsOn(channel: ChatSession): string {
  if (!channel.node) return "Runs on Vektor";
  const state = channel.nodeOnline === false ? " · offline" : "";
  return `Runs ${channel.nodeAgent} on ${channel.node}${state}`;
}

/** A bot's channel: its timeline and composer, and a thread beside it. */
export function BotChannelView() {
  const params = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams<{ thread?: string }>();
  const navigate = useNavigate();
  const { currentSpace } = useSpace();
  const channels = useBotChannels();
  const people = useChatPeople();
  const actions = useBotActions();

  const channel = createMemo(
    () => channels()?.find((candidate) => candidate.id === params.sessionId) ?? null,
  );
  const threads = useChatThreads(() => channel()?.id ?? null);
  const thread = createMemo(
    () => [...threads().values()].find((candidate) => candidate.id === searchParams.thread) ?? null,
  );
  const role = () => currentSpace()?.userRole;
  const mayEdit = () => canEdit(role());
  const readonlyReason = () => {
    const current = channel();
    if (!current || current.access === "viewer" || mayEdit()) return undefined;
    return "Only editors can post to this bot.";
  };
  const bot = () => {
    const current = channel();
    return current ? { name: current.title, avatar: current.avatar } : undefined;
  };

  const channelChat = useChatSession({
    sessionId: () => channel()?.id ?? null,
    running: () => channel()?.running ?? false,
    currentUserId: people.currentUserId,
  });
  const threadChat = useChatSession({
    sessionId: () => thread()?.id ?? null,
    running: () => thread()?.running ?? false,
    currentUserId: people.currentUserId,
  });
  const threadRoot = createMemo(() => {
    const seq = thread()?.threadRootSeq;
    return channelChat.messages.find((message) => message.seq === seq) ?? null;
  });

  const [showEditor, setShowEditor] = createSignal(false);
  const agentsByRunner = useAgentRunnerAgents(showEditor);

  usePageTitle(() => channel()?.title);

  async function openThread(seq: number) {
    const current = channel();
    if (!current) return;
    const id = threads().get(seq)?.id ?? (await actions.openThread(current.id, seq));
    setSearchParams({ thread: id });
  }

  async function deleteBot() {
    const current = channel();
    if (!current) return;
    const confirmed = await confirmDialog(
      `Delete ${current.title}? Its channel, threads and memory are deleted for everyone.`,
      { tone: "danger", confirmLabel: "Delete bot" },
    );
    if (!confirmed) return;
    await actions.remove(current.id);
    navigate("/");
  }

  return (
    <div class="relative flex h-dvh flex-col overflow-hidden max-md:h-(--app-height)">
      <inset-view class="flex min-h-0 flex-1 md:mr-(--inset-right) md:ml-(--inset-left)">
        <Show
          when={channel()}
          fallback={
            <div class="flex flex-1 items-center justify-center text-neutral-500 text-size-small">
              {channels() ? "This bot does not exist." : ""}
            </div>
          }
        >
          {(current) => (
            <>
              <div class="flex min-w-0 flex-1 flex-col">
                <div class="flex shrink-0 items-center gap-2 border-neutral-100 border-b px-4 py-2">
                  <BotAvatar avatar={current().avatar} class="h-8 w-8 text-size-medium" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium text-neutral-900">{current().title}</div>
                    <div
                      class="truncate text-size-extra-small"
                      classList={{
                        "text-neutral-500": current().nodeOnline !== false,
                        "text-red-600": current().nodeOnline === false,
                      }}
                    >
                      {runsOn(current())}
                      {current().running ? " · answering…" : ""}
                    </div>
                  </div>
                  <Show when={mayEdit()}>
                    <IconButton
                      icon="settings"
                      label="Edit bot"
                      tooltipPos="bottom"
                      onClick={() => setShowEditor(true)}
                    />
                  </Show>
                </div>
                <ChatConversation
                  chat={channelChat}
                  class="flex-1"
                  placeholder={`Message ${current().title}`}
                  emptyTitle={`This is ${current().title}'s channel`}
                  emptyHint={current().rolePrompt ?? "Ask anything; everyone in the space sees the conversation."}
                  readonlyReason={readonlyReason()}
                  bot={bot()}
                  authorOf={people.authorOf}
                  currentUserId={people.currentUserId()}
                  threadOf={(seq) => threads().get(seq)}
                  onOpenThread={(seq) => void openThread(seq)}
                />
              </div>

              <Show when={thread()}>
                {(open) => (
                  <aside class="flex w-[380px] min-w-0 shrink-0 flex-col border-neutral-100 border-l max-md:absolute max-md:inset-0 max-md:z-10 max-md:w-auto max-md:bg-neutral-10">
                    <div class="flex shrink-0 items-center gap-2 border-neutral-100 border-b px-4 py-2">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-neutral-900">Thread</div>
                        <div class="truncate text-neutral-500 text-size-extra-small">
                          {open().title}
                        </div>
                      </div>
                      <IconButton
                        icon="cancel"
                        label="Close thread"
                        tooltipPos="bottom"
                        onClick={() => setSearchParams({ thread: undefined })}
                      />
                    </div>
                    <Show when={threadRoot()}>
                      {(root) => (
                        <div class="shrink-0 border-neutral-100 border-b bg-neutral-50 px-4 py-2 text-neutral-600 text-size-small">
                          <div class="line-clamp-4 whitespace-pre-wrap">{root().content}</div>
                        </div>
                      )}
                    </Show>
                    <ChatConversation
                      chat={threadChat}
                      class="flex-1"
                      placeholder="Reply…"
                      emptyTitle="Start the thread"
                      emptyHint={`${current().title} answers here, with the message above in mind.`}
                      readonlyReason={readonlyReason()}
                      bot={bot()}
                      authorOf={people.authorOf}
                      currentUserId={people.currentUserId()}
                    />
                  </aside>
                )}
              </Show>

              <BotEditorDialog
                show={showEditor()}
                onUpdateShow={setShowEditor}
                bot={current()}
                agentsByRunner={agentsByRunner() ?? {}}
                onSave={(draft) => actions.update(current().id, draft)}
                onDelete={deleteBot}
              />
            </>
          )}
        </Show>
      </inset-view>
    </div>
  );
}
