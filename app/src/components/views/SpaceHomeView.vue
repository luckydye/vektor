<script setup lang="ts">
import { computed } from "vue";
import FileDropOverlay from "#components/FileDropOverlay.vue";
import PinnedDocument from "#components/PinnedDocument.vue";
import RecentDocuments from "#components/RecentDocuments.vue";
import SpaceActivityFeed from "#components/SpaceActivityFeed.vue";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { toAbsoluteUploadUrl } from "#files/fileTypes.ts";
import { t } from "#utils/lang.ts";

const { currentSpace } = useSpace();
const { uploadFile } = useUploads();
const userCanUpload = computed(() => canEdit(currentSpace.value?.userRole));

usePageTitle(null);

async function uploadDroppedFile(file: File) {
  const spaceId = currentSpace.value?.id;
  if (!spaceId || !userCanUpload.value) return;

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
  } catch {
    // The shared upload manager reports the failure through the progress toast.
  }
}
</script>

<template>
  <FileDropOverlay
    v-if="currentSpace"
    :disabled="!userCanUpload"
    class="min-h-screen h-full flex flex-col relative overflow-x-hidden"
    @select="uploadDroppedFile"
  >
    <inset-view
      class="block space-y-12 pt-m pb-20 lg:pb-8 h-full print:px-0 px-xs lg:px-xl md:ml-(--inset-left) md:mr-(--inset-right)"
    >
      <PinnedDocument
        v-if="currentSpace.preferences.pinnedDocumentId"
        :spaceId="currentSpace.id"
        :pinnedDocumentId="currentSpace.preferences.pinnedDocumentId"
      />

      <div>
        <RecentDocuments :spaceId="currentSpace.id" :limit="10" />
      </div>

      <div class="mb-20">
        <SpaceActivityFeed :spaceId="currentSpace.id" :limit="15" />
      </div>
    </inset-view>
  </FileDropOverlay>
</template>
