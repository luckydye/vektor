<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useAuditLogs } from "../composeables/useAuditLogs.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { formatDate } from "../utils/utils.ts";
import { Actions } from "../utils/actions.ts";
import ActivityEvent from "./ActivityEvent.vue";
import "@sv/elements/popover";
import { useMembers } from "../composeables/useMembers.ts";
import DockedPanel from "./DockedPanel.vue";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";

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
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
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
    const revision = item.revisionId ? revisionsByNumber.value.get(item.revisionId) : null;
    const isSuggestion = revision?.status !== null;

    return {
      variant: (item.revisionId ? "default" : "no-action") as "default" | "no-action",
      date: formatDate(
        typeof item.createdAt === "string"
          ? item.createdAt
          : item.createdAt.toISOString(),
      ),
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
    revision:
      '<svg class="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>',
    view: '<svg class="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>',
    publish:
      '<svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>',
    suggest:
      '<svg class="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h8M8 14h5m5 7H6a2 2 0 01-2-2V5a2 2 0 012-2h8l6 6v10a2 2 0 01-2 2z" /></svg>',
    restore:
      '<svg class="w-4 h-4 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>',
    delete:
      '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>',
    acl_grant:
      '<svg class="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>',
    acl_revoke:
      '<svg class="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>',
    create:
      '<svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>',
    lock: '<svg class="w-4 h-4 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>',
    unlock:
      '<svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>',
    property_update:
      '<svg class="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>',
    property_delete:
      '<svg class="w-4 h-4 text-pink-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
    webhook_success:
      '<svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
    webhook_failed:
      '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
  };
  return (
    icons[iconType] ||
    '<svg class="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>'
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
      detail: { revision: rev, content: revision.content, isSuggestion: revision.status !== null },
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
    <div class="flex flex-col h-full">
      <!-- Toolbar -->
      <div class="flex items-center justify-end px-3 py-1.5 border-b border-neutral-100 shrink-0">
        <button
          @click="refresh"
          :disabled="isLoadingAudit"
          class="p-1.5 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
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
          <svg class="w-8 h-8 mx-auto mb-2 text-neutral-400 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <p class="text-sm text-neutral-600">Loading history...</p>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else-if="activityEvents.length === 0" class="flex-1 flex items-center justify-center">
        <div class="text-center px-4">
          <svg class="w-12 h-12 mx-auto mb-3 text-neutral-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
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
              <svg width="11" height="35" viewBox="0 0 11 35" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="5.5" cy="5.5" r="5.5" fill="currentColor" class="text-neutral-200" />
                <line x1="5.5" y1="11" x2="5.5" y2="35" stroke="currentColor" class="text-neutral-200" stroke-width="1" />
              </svg>
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
                    <svg class="w-[12px] h-[18px] text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                  </button>

                  <a-popover @exit="console.error" class="group" placements="bottom-end">
                    <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
                      <div class="bg-background border border-neutral-100 rounded-lg origin-top-right scale-95 transition-all shadow-large duration-150 group-[[enabled]]:scale-100 min-w-[160px]">
                        <button
                          @click="e => { exitPopover(e); handleRevisionAction(event.revisionNumber); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          View Revision
                        </button>
                        <button
                          @click="e => { exitPopover(e); showDiff(event.revisionNumber); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                          </svg>
                          Show Diff
                        </button>
                        <button
                          @click="e => { exitPopover(e); copyRevisionLink(event.id); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          Copy Link
                        </button>
                        <button
                          v-if="!event.isPublished && !event.isSuggestion"
                          @click="e => { exitPopover(e); handlePublishRevision(event.revisionNumber); }"
                          class="w-full px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          :disabled="isPublishing"
                        >
                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                          </svg>
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
