<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  clipboardIcon,
  clockIcon,
  copyIcon,
  dotsVerticalIcon,
  timelineNowDotIcon,
} from "~/src/assets/icons.ts";
import { useAuditLogs } from "../composeables/useAuditLogs.ts";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { Actions } from "../utils/actions.ts";
import { formatDate, normalizeTimestamp } from "../utils/utils.ts";
import ActivityEvent from "./ActivityEvent.vue";
import DockedPanel from "./DockedPanel.vue";
import "@sv/elements/popover";
import {
  checkCircleOutlineIcon,
  closeCircleIcon,
  documentIcon,
  documentTextIcon,
  editOutlineIcon,
  eyeIcon,
  infoIcon,
  lockIcon,
  plusSmallIcon,
  publishIcon,
  refreshIcon,
  trashCanIcon,
  unlockIcon,
} from "~/src/assets/icons.ts";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";
import { useMembers } from "../composeables/useMembers.ts";

const props = defineProps({
  documentId: {
    type: String,
    required: true,
  },
});

const {
  revisions,
  getRevision,
  publishRevision,
  fetchHistory,
  isLoading: isLoadingHistory,
} = useRevisions(props.documentId);

const {
  auditLogs,
  isLoading: isLoadingAudit,
  error: auditError,
  fetchAuditLogs,
} = useAuditLogs(props.documentId);

const { currentSpaceId } = useSpace();
const { spaceSlug } = useRoute();

const publishedRev = ref<number | null>(null);
const isPublishing = ref(false);
const selectedRevisionNumber = ref<number | null>(null);

const { toggle: toggleWindow, windows } = useDockedWindows();
const isOpen = computed(() => windows.value.get("revisions")?.open ?? false);

const combinedActivity = computed(() => {
  return auditLogs.value.sort((a, b) => {
    const dateA = normalizeTimestamp(a.createdAt).getTime();
    const dateB = normalizeTimestamp(b.createdAt).getTime();
    return dateB - dateA;
  });
});

const revisionsByNumber = computed(() => {
  return new Map(revisions.value.map((revision) => [revision.rev, revision]));
});

const { members } = useMembers();

const activityEvents = computed(() => {
  return combinedActivity.value.map((item) => {
    const isPublished = item.revisionId === publishedRev.value;
    const userName = item.userId
      ? members.value?.find((member) => member.userId === item.userId)?.user?.name ||
        "Unknown user"
      : "Unknown user";
    const description = formatEventName(userName, item.event);
    const revision = item.revisionId
      ? revisionsByNumber.value.get(item.revisionId)
      : null;
    const isSuggestion = revision?.status !== null;

    return {
      variant: (item.revisionId ? "default" : "no-action") as "default" | "no-action",
      date: formatDate(item.createdAt),
      description,
      revisionNumber: item.revisionId ?? undefined,
      id: item.id,
      isPublished,
      isSuggestion,
      revisionStatus: revision?.status ?? null,
      icon: item.event,
    };
  });
});

function getEventIcon(iconType: string) {
  const icons: Record<string, string> = {
    revision: `<span class="svg-icon w-4 h-4 text-neutral-500">${documentIcon}</span>`,
    view: `<span class="svg-icon w-4 h-4 text-neutral-400">${eyeIcon}</span>`,
    publish: `<span class="svg-icon w-4 h-4 text-blue-500">${publishIcon}</span>`,
    suggest: `<span class="svg-icon w-4 h-4 text-amber-500">${documentTextIcon}</span>`,
    restore: `<span class="svg-icon w-4 h-4 text-orange-500">${refreshIcon}</span>`,
    delete: `<span class="svg-icon w-4 h-4 text-red-500">${trashCanIcon}</span>`,
    acl_grant: `<span class="svg-icon w-4 h-4 text-purple-500">${lockIcon}</span>`,
    acl_revoke: `<span class="svg-icon w-4 h-4 text-purple-500">${lockIcon}</span>`,
    create: `<span class="svg-icon w-4 h-4 text-green-500">${plusSmallIcon}</span>`,
    lock: `<span class="svg-icon w-4 h-4 text-yellow-500">${lockIcon}</span>`,
    unlock: `<span class="svg-icon w-4 h-4 text-green-500">${unlockIcon}</span>`,
    property_update: `<span class="svg-icon w-4 h-4 text-indigo-500">${editOutlineIcon}</span>`,
    property_delete: `<span class="svg-icon w-4 h-4 text-pink-500">${closeCircleIcon}</span>`,
    webhook_success: `<span class="svg-icon w-4 h-4 text-green-500">${checkCircleOutlineIcon}</span>`,
    webhook_failed: `<span class="svg-icon w-4 h-4 text-red-500">${closeCircleIcon}</span>`,
  };
  return (
    icons[iconType] ||
    `<span class="svg-icon w-4 h-4 text-neutral-400">${infoIcon}</span>`
  );
}

async function fetchPublishedRev() {
  if (!currentSpaceId.value) return;

  try {
    const response = await fetch(
      `/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId}`,
    );
    if (response.ok) {
      const data = await response.json();
      publishedRev.value = data.document?.publishedRev || null;
    }
  } catch (err) {
    console.error("Failed to fetch published revision:", err);
  }
}

async function refresh() {
  await Promise.all([fetchAuditLogs(), fetchPublishedRev(), fetchHistory()]);
}

async function viewRevision(rev: number | undefined) {
  if (!rev) return;
  const revision = await getRevision(rev);
  if (revision) {
    selectedRevisionNumber.value = rev;

    const url = new URL(window.location.href);
    url.searchParams.set("revision", rev.toString());
    window.history.replaceState({}, "", url);

    const event = new CustomEvent("revision:view", {
      detail: {
        revision: rev,
        content: revision.content,
        isSuggestion: revision.status !== null,
      },
      bubbles: true,
      composed: true,
    });
    window.dispatchEvent(event);
  }
}

function closeRevisionView() {
  const event = new CustomEvent("revision:close", {
    bubbles: true,
    composed: true,
  });
  window.dispatchEvent(event);
}

async function publishRevisionAction(rev: number | undefined) {
  if (!rev) return;
  isPublishing.value = true;
  try {
    const success = await publishRevision(rev);
    if (success) {
      publishedRev.value = rev;
      await refresh();
      location.reload();
    }
  } finally {
    isPublishing.value = false;
  }
}

function formatEventName(userName: string, event: string): string {
  const eventNames: Record<string, string> = {
    view: `${userName} - Document viewed`,
    save: `${userName} - Document saved`,
    suggest: `${userName} - Suggested changes`,
    publish: `${userName} - Document published`,
    unpublish: `${userName} - Document unpublished`,
    restore: `${userName} - Revision restored`,
    delete: `${userName} - Document deleted`,
    acl_grant: `${userName} - Permission granted`,
    acl_revoke: `${userName} - Permission revoked`,
    create: `${userName} - Document created`,
    lock: `${userName} - Document locked`,
    unlock: `${userName} - Document unlocked`,
    property_update: `${userName} - Property updated`,
    property_delete: `${userName} - Property deleted`,
    webhook_success: `${userName} - Webhook delivered`,
    webhook_failed: `${userName} - Webhook failed`,
  };
  return eventNames[event] || event;
}

async function handleRevisionAction(revisionNumber: number | undefined) {
  await viewRevision(revisionNumber);
}

async function handlePublishRevision(revisionNumber: number | undefined) {
  await publishRevisionAction(revisionNumber);
}

function copyRevisionLink(revisionId?: string) {
  if (!spaceSlug.value || !revisionId) return;

  const url = `${window.location.origin}/${spaceSlug.value}/rev/${revisionId}`;
  navigator.clipboard.writeText(url);
}

function showDiff(revisionNumber: number | undefined) {
  if (!revisionNumber) return;

  const revision = revisionsByNumber.value.get(revisionNumber);

  const event = new CustomEvent("revision:diff", {
    detail: { revision: revisionNumber, isSuggestion: revision?.status !== null },
    bubbles: true,
    composed: true,
  });
  window.dispatchEvent(event);
}

Actions.register("revisions:toggle", {
  title: "Activity",
  icon: () => "history",
  description: "Open or close the document activity",
  group: "document",
  run: async () => {
    toggleWindow("revisions", { side: "right", width: 420 });
  },
});

onMounted(() => {
  const url = new URL(window.location.href);
  const revision = url.searchParams.get("revision");

  if (revision) {
    const rev = parseInt(revision, 10);
    if (!Number.isNaN(rev)) {
      if (currentSpaceId.value) {
        viewRevision(rev);
      } else {
        const unwatch = watch(currentSpaceId, (id) => {
          if (id) {
            viewRevision(rev);
            unwatch();
          }
        });
      }
    }
  }

  window.addEventListener("revision:close", onRevisionClose);
});

onUnmounted(() => {
  window.removeEventListener("revision:close", onRevisionClose);
});

function onRevisionClose() {
  selectedRevisionNumber.value = null;

  const url = new URL(window.location.href);
  url.searchParams.delete("revision");
  window.history.replaceState({}, "", url);
}

// Watch isOpen: fetch data when opened, keep notifying DocumentContent for compat
watch(
  isOpen,
  (newValue) => {
    if (newValue) {
      refresh();
    }

    window.dispatchEvent(
      new CustomEvent("revisions:toggled", {
        detail: { isOpen: newValue },
        bubbles: true,
        composed: true,
      }),
    );
  },
  { immediate: true },
);

function exitPopover(e: Event) {
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}
</script>

<template>
  <DockedPanel id="revisions" title="Document History" default-side="right" :default-width="420">
    <div class="relative flex flex-col h-full">
        <div class="absolute top-3 right-3">
            <button
                @click="refresh"
                :disabled="isLoadingAudit"
                class="p-1.5 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors disabled:opacity-50"
                title="Refresh"
            >
                <div class="svg-icon w-4 h-4" v-html="refreshIcon" />
            </button>
        </div>
    
      <!-- Error State -->
      <div v-if="auditError" class="mx-4 mt-4 p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded">
        {{ auditError }}
      </div>

      <!-- Loading State -->
      <div
        v-if="(isLoadingHistory || isLoadingAudit) && activityEvents.length === 0"
        class="flex-1 flex items-center justify-center"
      >
        <div class="text-center">
          <div class="svg-icon w-8 h-8 mx-auto mb-2 text-neutral-400 animate-spin" v-html="refreshIcon" />
          <p class="text-sm text-neutral-600">Loading history...</p>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else-if="activityEvents.length === 0" class="flex-1 flex items-center justify-center">
        <div class="text-center px-4">
          <div class="svg-icon w-12 h-12 mx-auto mb-3 text-neutral-300" v-html="clockIcon" />
          <p class="font-medium text-neutral-600">No activity yet</p>
          <p class="text-sm text-neutral-500 mt-1">Activity will appear here as you work</p>
        </div>
      </div>

      <!-- Activity Log -->
      <wiki-scroll v-else class="flex-1 overflow-y-auto" data-scroll-container>
        <div class="py-4 px-4">
          <!-- Now indicator -->
          <div class="flex flex-row gap-2xs mb-4xs">
            <div class="w-[11px] h-[35px] shrink-0 flex items-start justify-center">
              <div class="svg-icon w-[11px] h-[35px]" v-html="timelineNowDotIcon" />
            </div>
            <div class="text-label text-neutral-700">Now</div>
          </div>

          <!-- Activity events -->
          <div v-for="(event, index) in activityEvents" :key="index">
            <ActivityEvent :variant="event.variant" :date="event.date" :description="event.description">
              <template v-if="event.isPublished" #badge>
                <span class="px-2 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-700 uppercase">Published</span>
              </template>
              <template v-else-if="event.isSuggestion" #badge>
                <span class="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700 uppercase">
                  {{ event.revisionStatus === "applied" ? "Applied Suggestion" : "Suggestion" }}
                </span>
              </template>
              <template #icon>
                <div v-html="getEventIcon(event.icon)" class="flex-none"></div>
              </template>

              <template v-if="event.variant === 'default' && event.revisionNumber" #action>
                <a-popover-trigger :showdelay="0" :hidedelay="100">
                  <button
                    slot="trigger"
                    class="inline-flex items-center justify-center gap-5xs px-3xs h-9 border border-primary-100 rounded-sm hover:bg-primary-10 active:bg-primary-50 transition-colors"
                    title="Revision actions"
                  >
                    <div class="svg-icon w-[12px] h-[18px] text-primary-600" v-html="dotsVerticalIcon" />
                  </button>

                  <a-popover @exit="console.error" class="group" placements="bottom-end">
                    <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
                      <div class="bg-background border border-neutral-100 rounded-lg origin-top-right scale-95 transition-all shadow-large duration-150 group-[[enabled]]:scale-100 min-w-[160px]">
                        <button
                          @click="e => { exitPopover(e); handleRevisionAction(event.revisionNumber); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <div class="svg-icon w-4 h-4" v-html="eyeIcon" />
                          View Revision
                        </button>
                        <button
                          @click="e => { exitPopover(e); showDiff(event.revisionNumber); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <div class="svg-icon w-4 h-4" v-html="clipboardIcon" />
                          Show Diff
                        </button>
                        <button
                          @click="e => { exitPopover(e); copyRevisionLink(event.id); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <div class="svg-icon w-4 h-4" v-html="copyIcon" />
                          Copy Link
                        </button>
                        <button
                          v-if="!event.isPublished && !event.isSuggestion"
                          @click="e => { exitPopover(e); handlePublishRevision(event.revisionNumber); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          :disabled="isPublishing"
                        >
                          <div class="svg-icon w-4 h-4" v-html="publishIcon" />
                          Publish Revision
                        </button>
                      </div>
                    </div>
                  </a-popover>
                </a-popover-trigger>
              </template>
            </ActivityEvent>
          </div>
        </div>
      </wiki-scroll>
    </div>
  </DockedPanel>
</template>

<style scoped>
:deep(svg) {
  display: block;
}

:deep(circle) {
  fill: var(--color-neutral-200);
}

:deep(line) {
  stroke: var(--color-neutral-200);
}
</style>
