import { createMemo, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import { FileDropOverlay } from "#components/FileDropOverlay.tsx";
import { PinnedDocument } from "#components/PinnedDocument.tsx";
import { RecentDocuments } from "#components/RecentDocuments.tsx";
import { SpaceActivityFeed } from "#components/SpaceActivityFeed.tsx";
import { SpaceHomeHeadline } from "#components/SpaceHomeHeadline.tsx";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { toAbsoluteUploadUrl } from "#files/fileTypes.ts";

function greetingKey(hour: number): "Good morning" | "Good afternoon" | "Good evening" {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function firstName(name: string | undefined): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined;
}

export function SpaceHomeView() {
  const t = useTranslation();
  const locale = useLocale();
  const user = useUserProfile();
  const now = new Date();

  const { currentSpace } = useSpace();
  const { uploadFile } = useUploads();
  const userCanUpload = createMemo(() => canEdit(currentSpace()?.userRole));

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
          class="relative flex h-full min-h-screen flex-col overflow-x-hidden"
          onSelect={(file) => void uploadDroppedFile(file)}
        >
          <inset-view class="block h-full space-y-12 px-xs pt-m pb-20 md:mr-(--inset-right) md:ml-(--inset-left) lg:px-xl lg:pb-8 print:px-0">
            <SpaceHomeHeadline
              date={new Intl.DateTimeFormat(locale, {
                weekday: "long",
                month: "long",
                day: "numeric",
              }).format(now)}
              greeting={t(greetingKey(now.getHours()))}
              name={firstName(user()?.name)}
              subtitle={t("Here’s what moved forward in {space}.").replace(
                "{space}",
                space().name,
              )}
            />

            <Show when={space().preferences.pinnedDocumentId}>
              {(pinnedId) => (
                <PinnedDocument spaceId={space().id} pinnedDocumentId={pinnedId()} />
              )}
            </Show>

            <div>
              <RecentDocuments limit={10} />
            </div>

            <div class="mb-20">
              <SpaceActivityFeed spaceId={space().id} limit={15} />
            </div>
          </inset-view>
        </FileDropOverlay>
      )}
    </Show>
  );
}
