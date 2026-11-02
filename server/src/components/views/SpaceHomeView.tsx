import { createMemo, createSignal, Show } from "solid-js";
import type { AIChatSessionListEntry } from "#api/client.ts";
import { canEdit } from "#acl/permissions.ts";
import { AgentSection } from "#components/AgentSection.tsx";
import { AIChatConversation } from "#components/AIChatConversation.tsx";
import { IconButton } from "#components/IconButton.tsx";
import { FileDropOverlay } from "#components/FileDropOverlay.tsx";
import { SpaceActivityFeed } from "#components/SpaceActivityFeed.tsx";
import { useAgentChat } from "#composeables/useAgentChat.ts";
import { useRecentChatSessions } from "#composeables/useChatSessionHandling.ts";
import { useAgentAvailable } from "#composeables/useIntegrationAIModel.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { toAbsoluteUploadUrl } from "#files/fileTypes.ts";
import { spacePath } from "#utils/utils.ts";

export function SpaceHomeView() {
  const t = useTranslation();
  const locale = useLocale();

  const { currentSpace } = useSpace();
  const { uploadFile } = useUploads();
  const userCanUpload = createMemo(() => canEdit(currentSpace()?.userRole));
  const agentAvailable = useAgentAvailable();
  const recentSessions = useRecentChatSessions(3);

  // The dashboard hosts its own chat; once a conversation starts it takes over the page.
  const [chatActive, setChatActive] = createSignal(false);
  const chat = useAgentChat({ documentId: () => "", isActive: () => agentAvailable() !== false });

  function ask(message: string) {
    setChatActive(true);
    chat.setShowSessionPicker(false);
    chat.setMessageInput(message);
    chat.startNewChat();
    void chat.sendMessage();
  }

  function resume(session: AIChatSessionListEntry) {
    setChatActive(true);
    void chat.resumeSession(session);
  }

  function showHistory() {
    setChatActive(true);
    chat.setShowSessionPicker(true);
  }

  usePageTitle(null);

  async function uploadDroppedFile(file: File) {
    const spaceId = currentSpace()?.id;
    if (!spaceId || !userCanUpload()) return;

    try {
      await uploadFile(file, {
        spaceId,
        successToast: {
          duration: 8000,
          action: (result) => ({
            label: t("Copy link"),
            completedLabel: t("Copied"),
            run: () => navigator.clipboard.writeText(toAbsoluteUploadUrl(result.url)),
          }),
        },
      });
    } catch {}
  }

  return (
    <Show when={currentSpace()}>
      {(space) => (
        <FileDropOverlay
          disabled={!userCanUpload()}
          class="relative flex h-dvh flex-col overflow-hidden"
          onSelect={(file) => void uploadDroppedFile(file)}
        >
          <inset-view class="flex min-h-0 flex-1 flex-col gap-12 p-2xs *:mx-auto *:w-full *:max-w-(--document-width) md:mr-(--inset-right) md:ml-(--inset-left) print:px-0">
            <Show
              when={chatActive() && agentAvailable() !== false}
              fallback={
                <>
                  <Show when={agentAvailable() !== false}>
                    <div class="py-6">
                      <AgentSection
                        viewAllLabel={t("View all")}
                        placeholder={t("What can I help with?")}
                        emptyLabel={t("No conversations yet.")}
                        lang={locale}
                        spaceId={space().id}
                        disabled={agentAvailable() === undefined}
                        sessions={recentSessions()}
                        rows={3}
                        onAsk={ask}
                        onResume={resume}
                        onViewAll={showHistory}
                      />
                    </div>
                  </Show>

                  <div class="flex min-h-0 flex-1 flex-col">
                    <SpaceActivityFeed
                      spaceId={space().id}
                      limit={30}
                      viewAllHref={spacePath(space().slug, "/search")}
                    />
                  </div>
                </>
              }
            >
              <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div class="flex shrink-0 items-center gap-1 py-1.5">
                  <IconButton
                    icon="arrow-left"
                    label={t("Back")}
                    tooltipPos="bottom"
                    onClick={() => setChatActive(false)}
                  />
                  <span class="min-w-0 flex-1 truncate font-medium text-size-small">
                    Assistant
                  </span>
                  <IconButton
                    icon="activity"
                    label="Chat history"
                    tooltipPos="bottom"
                    class={chat.showSessionPicker() ? "bg-neutral-100 text-neutral-900" : ""}
                    onClick={() => chat.setShowSessionPicker(!chat.showSessionPicker())}
                  />
                  <IconButton
                    icon="edit-entry"
                    label="New chat"
                    tooltipPos="bottom"
                    disabled={chat.isGenerating()}
                    onClick={() => {
                      chat.setShowSessionPicker(false);
                      chat.startNewChat();
                    }}
                  />
                </div>
                <AIChatConversation chat={chat} class="flex-1" />
              </div>
            </Show>
          </inset-view>
        </FileDropOverlay>
      )}
    </Show>
  );
}
