import { createMemo, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import { FileDropOverlay } from "#components/FileDropOverlay.tsx";
import { SpaceActivityFeed } from "#components/SpaceActivityFeed.tsx";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { toAbsoluteUploadUrl } from "#files/fileTypes.ts";
import { spacePath } from "#utils/utils.ts";

export function SpaceHomeView() {
  const t = useTranslation();

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
          class="relative flex h-dvh flex-col overflow-hidden max-md:h-(--app-height)"
          onSelect={(file) => void uploadDroppedFile(file)}
        >
          <inset-view class="flex min-h-0 flex-1 flex-col gap-12 p-2xs *:mx-auto *:w-full *:max-w-(--document-width) md:mr-(--inset-right) md:ml-(--inset-left) print:px-0">
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
