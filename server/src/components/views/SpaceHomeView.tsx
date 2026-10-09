import { createMemo, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import { AgentSection } from "#components/AgentSection.tsx";
import { FileDropOverlay } from "#components/FileDropOverlay.tsx";
import { SpaceActivityFeed } from "#components/SpaceActivityFeed.tsx";
import { SpaceHomeHeadline } from "#components/SpaceHomeHeadline.tsx";
import { useRecentChatSessions } from "#composeables/useChatSessionHandling.ts";
import { useAgentAvailable } from "#composeables/useIntegrationAIModel.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { useWeather } from "#composeables/useWeather.ts";
import { toAbsoluteUploadUrl } from "#files/fileTypes.ts";
import { Actions } from "#utils/actions.ts";
import { spacePath } from "#utils/utils.ts";

export function SpaceHomeView() {
  const t = useTranslation();
  const locale = useLocale();
  const now = new Date();

  const { currentSpace } = useSpace();
  const { uploadFile } = useUploads();
  const userCanUpload = createMemo(() => canEdit(currentSpace()?.userRole));
  const agentAvailable = useAgentAvailable();
  const recentSessions = useRecentChatSessions(3);
  const weather = useWeather();

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
          <inset-view class="flex min-h-0 flex-1 flex-col gap-12 p-2xs md:mr-(--inset-right) md:ml-(--inset-left) print:px-0">
            <SpaceHomeHeadline
              date={new Intl.DateTimeFormat(locale, {
                weekday: "long",
                month: "long",
                day: "numeric",
              }).format(now)}
              weather={weather()}
            />

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
                  onAsk={(message) => Actions.emit("ai-chat:ask", { detail: message })}
                  onResume={(session) => Actions.emit("ai-chat:resume", { detail: session })}
                  onViewAll={() => Actions.emit("ai-chat:sessions", {})}
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
          </inset-view>
        </FileDropOverlay>
      )}
    </Show>
  );
}
