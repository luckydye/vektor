import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import type { ChatSession } from "#api/client.ts";
import { BotAvatar, type RoleProposals } from "#components/AIChatMessages.tsx";
import { BotEditorDialog } from "#components/BotEditorDialog.tsx";
import { ChatConversation } from "#components/ChatConversation.tsx";
import { ContextMenu, ContextMenuSeparator } from "#components/ContextMenu.tsx";
import { ContextMenuItem } from "#components/ContextMenuItem.tsx";
import { Icon } from "#components/Icon.tsx";
import { DockedPanel } from "#components/DockedPanel.tsx";
import {
  useAgentRunnerAgents,
  useBotActions,
  useBotChannels,
  useChatPeople,
  useChatThreads,
} from "#composeables/useBotChannels.ts";
import {
  roleChanges,
  roleProposalStatus,
  useChatSession,
} from "#composeables/useChatSession.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

/** Where a bot runs, and whether it can answer from there. */
function runsOn(channel: ChatSession): string {
  if (!channel.node) return "Runs on Vektor";
  const state = channel.nodeOnline === false ? " · offline" : "";
  return `Runs ${channel.nodeAgent} on ${channel.node}${state}`;
}

/** The docked window a channel's open thread shows in. */
const THREAD_PANEL = "bot-thread";
const THREAD_PANEL_DEFAULTS = { side: "right", width: 400 } as const;

/** Closes the menu an item was picked from. */
function closeMenu(event: Event) {
  (event.currentTarget as Element).dispatchEvent(new CustomEvent("exit", { bubbles: true }));
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

  /** The bot's proposals to change its role, applied by editors. */
  /** The bot's role proposals in `sessionId`, the channel or a thread of it. */
  const roleProposals = (sessionId: string | undefined): RoleProposals => ({
    // Against the role it was made against, where that is known.
    changes: (proposal) =>
      roleChanges(
        proposal.previous !== undefined ? proposal.previous : (channel()?.rolePrompt ?? null),
        proposal.rolePrompt,
      ),
    status: (proposal) => roleProposalStatus(proposal, channel()?.rolePrompt ?? null),
    apply:
      mayEdit() && sessionId
        ? (proposal) => actions.applyRoleProposal(sessionId, proposal.callId)
        : undefined,
  });

  const [showEditor, setShowEditor] = createSignal(false);
  const agentsByRunner = useAgentRunnerAgents(showEditor);

  usePageTitle(() => channel()?.title);

  // The `thread` parameter says which thread is open; the docked panel shows it.
  // Each side reacts only to the other changing, so neither can bounce back.
  const { open: openWindow, close: closeWindow, windows } = useDockedWindows();
  const panelOpen = () => windows().get(THREAD_PANEL)?.open ?? false;
  createEffect(
    on(
      () => searchParams.thread,
      (threadId) => {
        // After the first registration, which restores the remembered state in a
        // microtask of its own and would otherwise close the panel again.
        if (threadId) queueMicrotask(() => openWindow(THREAD_PANEL, THREAD_PANEL_DEFAULTS));
        else if (panelOpen()) closeWindow(THREAD_PANEL);
      },
    ),
  );
  createEffect(
    on(panelOpen, (isOpen, wasOpen) => {
      if (wasOpen && !isOpen && searchParams.thread) setSearchParams({ thread: undefined });
      // Remembered as open from an earlier visit, but no thread is picked.
      if (isOpen && !searchParams.thread) closeWindow(THREAD_PANEL);
    }),
  );

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
                <div class="flex h-12 shrink-0 items-center gap-2 border-neutral-100 border-b px-4">
                  <BotAvatar
                    avatar={current().avatar}
                    class="h-6 w-6 rounded-full text-size-small"
                  />
                  <span class="shrink-0 font-semibold text-neutral-900">{current().title}</span>
                  <span class="h-5 w-px shrink-0 bg-neutral-200" />
                  <span
                    class="min-w-0 flex-1 truncate text-size-small"
                    classList={{
                      "text-neutral-500": current().nodeOnline !== false,
                      "text-red-600": current().nodeOnline === false,
                    }}
                    title={current().rolePrompt ?? undefined}
                  >
                    {current().rolePrompt ? `${current().rolePrompt} · ` : ""}
                    {runsOn(current())}
                  </span>
                  <Show when={mayEdit()}>
                    <ContextMenu
                      placements="bottom-end"
                      ariaLabel="Bot actions"
                      trigger={
                        <button
                          type="button"
                          slot="trigger"
                          aria-label="Bot actions"
                          class="flex cursor-pointer rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 aria-expanded:bg-neutral-100 aria-expanded:text-neutral-900"
                        >
                          <Icon name="context-menu-more" class="h-4 w-4" />
                        </button>
                      }
                    >
                      <ContextMenuItem
                        onClick={(event) => {
                          closeMenu(event);
                          setShowEditor(true);
                        }}
                      >
                        <Icon name="settings" class="h-4 w-4 flex-none" />
                        <span class="text-neutral-900">Edit bot</span>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={(event) => {
                          closeMenu(event);
                          void deleteBot();
                        }}
                      >
                        <Icon name="delete-entry" class="h-4 w-4 flex-none text-red-600" />
                        <span class="text-red-600">Delete bot</span>
                      </ContextMenuItem>
                    </ContextMenu>
                  </Show>
                </div>
                <ChatConversation
                  chat={channelChat}
                  class="flex-1"
                  placeholder={`Message ${current().title}`}
                  emptyTitle={`This is ${current().title}'s channel`}
                  emptyHint={current().rolePrompt ?? "Ask anything; everyone in the space sees the conversation."}
                  readonlyReason={readonlyReason()}
                  typing={
                    current().running || channelChat.isGenerating() ? current().title : undefined
                  }
                  bot={bot()}
                  authorOf={people.authorOf}
                  threadOf={(seq) => threads().get(seq)}
                  onOpenThread={(seq) => void openThread(seq)}
                  roleProposals={roleProposals(current().id)}
                />
              </div>

              <DockedPanel
                id={THREAD_PANEL}
                title={thread()?.title ?? "Thread"}
                defaultSide={THREAD_PANEL_DEFAULTS.side}
                defaultWidth={THREAD_PANEL_DEFAULTS.width}
              >
                <Show when={thread()}>
                  {(open) => (
                    <div class="flex h-full min-h-0 flex-col">
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
                        typing={
                          open().running || threadChat.isGenerating()
                            ? current().title
                            : undefined
                        }
                        bot={bot()}
                        authorOf={people.authorOf}
                        roleProposals={roleProposals(open().id)}
                      />
                    </div>
                  )}
                </Show>
              </DockedPanel>

              <BotEditorDialog
                show={showEditor()}
                onUpdateShow={setShowEditor}
                bot={current()}
                agentsByRunner={agentsByRunner() ?? {}}
                onSave={(draft) => actions.update(current().id, draft)}
              />
            </>
          )}
        </Show>
      </inset-view>
    </div>
  );
}
