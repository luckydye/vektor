<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { AuditLog } from "#api/client.ts";
import { useAuditLogs } from "#composeables/useAuditLogs.ts";
import { useRevisions } from "#composeables/useRevisions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { Actions } from "#utils/actions.ts";
import { replaceBrowserUrl } from "#utils/browserHistory.ts";
import { t } from "#utils/lang.ts";
import { normalizeTimestamp } from "#utils/utils.ts";
import {
  clipboardIcon,
  clockIcon,
  copyIcon,
  dotsVerticalIcon,
  eyeIcon,
  publishIcon,
  refreshIcon,
  timelineNowDotIcon,
} from "~/src/assets/icons.ts";
import DockedPanel from "./DockedPanel.vue";
import DocumentActivityFeed from "./DocumentActivityFeed.vue";
import Pager from "./Pager.vue";
import "@atrium-ui/elements/popover";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useMembers } from "#composeables/useMembers.ts";
import { useSync } from "#composeables/useSync.ts";
import { realtimeTopics } from "#utils/realtime.ts";

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
  isFetching: isFetchingAudit,
  error: auditError,
  fetchAuditLogs,
  page,
  totalPages,
  goToPage,
} = useAuditLogs(props.documentId);

const { currentSpaceId } = useSpace();
const { members } = useMembers();

const publishedRev = ref<number | null>(null);
const isPublishing = ref(false);
const selectedRevisionNumber = ref<number | null>(null);

const { toggle: toggleWindow, windows } = useDockedWindows();
const isOpen = computed(() => windows.value.get("revisions")?.open ?? false);

function dispatchWindowEvent(event: Event) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(event);
}

/** Sorted audit log entries, newest first. */
const sortedEntries = computed(() =>
  [...auditLogs.value].sort((a, b) => {
    return (
      normalizeTimestamp(b.createdAt).getTime() -
      normalizeTimestamp(a.createdAt).getTime()
    );
  }),
);

const revisionsByNumber = computed(() => new Map(revisions.value.map((r) => [r.rev, r])));

// ---------------------------------------------------------------------------
// User resolver passed to DocumentActivityFeed
// ---------------------------------------------------------------------------

function getUserName(userId?: string | null): string {
  if (!userId) return "Unknown user";
  const member = members.value?.find((m) => m.userId === userId);
  return member?.user?.name || member?.user?.email || userId;
}

function getUser(userId?: string | null) {
  if (!userId) return undefined;
  return members.value?.find((m) => m.userId === userId)?.user ?? undefined;
}

// ---------------------------------------------------------------------------
// Per-entry helpers used in the action slot
// ---------------------------------------------------------------------------

function isPublishedEntry(entry: AuditLog): boolean {
  return !!entry.revisionId && entry.revisionId === publishedRev.value;
}

function isSuggestionEntry(entry: AuditLog): boolean {
  if (!entry.revisionId) return false;
  const revision = revisionsByNumber.value.get(entry.revisionId);
  return revision != null && revision.status !== null;
}

function revisionStatusOf(entry: AuditLog): string | null {
  if (!entry.revisionId) return null;
  return revisionsByNumber.value.get(entry.revisionId)?.status ?? null;
}

/** The most recent entry in a group that has a revision (used for the header action). */
function primaryRevisionEntry(items: AuditLog[]): AuditLog | undefined {
  return items.find((i) => !!i.revisionId);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Revision actions
// ---------------------------------------------------------------------------

async function viewRevision(revisionId: number | null | undefined) {
  if (!revisionId) return;
  const revision = await getRevision(revisionId);
  if (revision) {
    selectedRevisionNumber.value = revisionId;

    const url = new URL(window.location.href);
    url.searchParams.set("revision", revisionId.toString());
    replaceBrowserUrl(url);

    dispatchWindowEvent(
      new CustomEvent("revision:view", {
        detail: {
          revision: revisionId,
          content: revision.content,
          isSuggestion: revision.status !== null,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

async function publishRevisionAction(revisionId: number | null | undefined) {
  if (!revisionId) return;
  isPublishing.value = true;
  try {
    const success = await publishRevision(revisionId);
    if (success) {
      publishedRev.value = revisionId;
      await refresh();
    }
  } finally {
    isPublishing.value = false;
  }
}

function copyRevisionLink(entryId: string) {
  const url = `${window.location.origin}/rev/${entryId}`;
  navigator.clipboard.writeText(url);
}

function showDiff(entry: AuditLog) {
  if (!entry.revisionId) return;
  const revision = revisionsByNumber.value.get(entry.revisionId);
  dispatchWindowEvent(
    new CustomEvent("revision:diff", {
      detail: { revision: entry.revisionId, isSuggestion: revision?.status !== null },
      bubbles: true,
      composed: true,
    }),
  );
}

function exitPopover(e: Event) {
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Lifecycle / panel watcher
// ---------------------------------------------------------------------------

Actions.register("revisions:toggle", {
  title: t("Activity"),
  icon: () => "history",
  description: t("Open or close the document activity"),
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
  replaceBrowserUrl(url);
}

watch(
  [isOpen, currentSpaceId],
  ([open, spaceId], prev) => {
    if (open && spaceId) {
      refresh();
    }
    const prevOpen = prev?.[0];
    if (open !== prevOpen) {
      dispatchWindowEvent(
        new CustomEvent("revisions:toggled", {
          detail: { isOpen: open },
          bubbles: true,
          composed: true,
        }),
      );
    }
  },
  { immediate: true },
);

useSync(
  currentSpaceId,
  () => [realtimeTopics.document(props.documentId)],
  (scopes) => {
    if (!scopes.includes(realtimeTopics.document(props.documentId))) return;

    if (isOpen.value) {
      refresh();
    } else {
      fetchPublishedRev();
    }
  },
);
</script>

<template>
  <DockedPanel id="revisions" title="Document Activity" default-side="right" :default-width="420">
    <div class="relative flex flex-col h-full">

      <!-- Error State -->
      <div v-if="auditError" class="mx-4 mt-4 p-3 text-size-medium text-red-700 bg-red-50 border border-red-200 rounded-sm">
        {{ auditError }}
      </div>

      <!-- Loading State -->
      <div
        v-if="(isLoadingHistory || isLoadingAudit) && sortedEntries.length === 0"
        class="flex-1 flex items-center justify-center"
      >
        <div class="text-center">
          <div class="svg-icon w-8 h-8 mx-auto mb-2 text-neutral-400 animate-spin" v-html="refreshIcon" />
          <p class="text-size-medium text-neutral-600">Loading history...</p>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else-if="sortedEntries.length === 0" class="flex-1 flex items-center justify-center">
        <div class="text-center px-4">
          <div class="svg-icon w-12 h-12 mx-auto mb-3 text-neutral-300" v-html="clockIcon" />
          <p class="font-medium text-neutral-600">No activity yet</p>
          <p class="text-size-medium text-neutral-500 mt-1">Activity will appear here as you work</p>
        </div>
      </div>

      <!-- Activity Feed -->
      <wiki-scroll v-else class="flex-1 overflow-y-auto" data-scroll-container>
        <div class="py-2 px-2">
          <DocumentActivityFeed
            :entries="sortedEntries"
            :get-user-name="getUserName"
            :get-user="getUser"
          >
            <!-- ⋯ button in the header row, acting on the most recent revision in the group -->
            <template #header-actions="{ items }">
              <div v-if="primaryRevisionEntry(items)" class="shrink-0">
                <a-popover-trigger :showdelay="0" :hidedelay="100">
                  <button
                    slot="trigger"
                    class="inline-flex items-center justify-center w-7 h-7 rounded-sm hover:bg-neutral-200 transition-colors"
                    title="Revision actions"
                  >
                    <div class="svg-icon w-[12px] h-[18px] text-neutral-500" v-html="dotsVerticalIcon" />
                  </button>

                  <a-popover @exit="console.error" class="group" placements="bottom-end">
                    <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
                      <div class="bg-background border border-neutral-100 rounded-lg origin-top-right scale-95 transition-all shadow-large duration-150 group-[[enabled]]:scale-100 min-w-[160px]">
                        <button
                          @click="e => { exitPopover(e); viewRevision(primaryRevisionEntry(items)!.revisionId); }"
                          class="w-full px-4 py-2 text-left text-size-medium text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <div class="svg-icon w-4 h-4" v-html="eyeIcon" />
                          View Revision
                        </button>
                        <button
                          @click="e => { exitPopover(e); showDiff(primaryRevisionEntry(items)!); }"
                          class="w-full px-4 py-2 text-left text-size-medium text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <div class="svg-icon w-4 h-4" v-html="clipboardIcon" />
                          Show Diff
                        </button>
                        <button
                          @click="e => { exitPopover(e); copyRevisionLink(primaryRevisionEntry(items)!.id); }"
                          class="w-full px-4 py-2 text-left text-size-medium text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors"
                        >
                          <div class="svg-icon w-4 h-4" v-html="copyIcon" />
                          Copy Link
                        </button>
                        <button
                          v-if="!isPublishedEntry(primaryRevisionEntry(items)!) && !isSuggestionEntry(primaryRevisionEntry(items)!)"
                          @click="e => { exitPopover(e); publishRevisionAction(primaryRevisionEntry(items)!.revisionId); }"
                          class="w-full px-4 py-2 text-left text-size-medium text-neutral-800 hover:bg-neutral-100 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          :disabled="isPublishing"
                        >
                          <div class="svg-icon w-4 h-4" v-html="publishIcon" />
                          Publish Revision
                        </button>
                      </div>
                    </div>
                  </a-popover>
                </a-popover-trigger>
              </div>
            </template>

            <!-- Published / Suggestion badge per entry -->
            <template #entry-actions="{ entry }">
              <span
                v-if="isPublishedEntry(entry)"
                class="shrink-0 self-center px-1.5 py-px text-[10px] font-medium uppercase tracking-wide rounded-sm border border-blue-200 text-blue-600 bg-blue-50"
              >Published</span>
              <span
                v-else-if="isSuggestionEntry(entry)"
                class="shrink-0 self-center px-1.5 py-px text-[10px] font-medium uppercase tracking-wide rounded-sm border border-amber-200 text-amber-600 bg-amber-50"
              >{{ revisionStatusOf(entry) === "applied" ? "Applied" : "Suggestion" }}</span>
            </template>
          </DocumentActivityFeed>
        </div>
      </wiki-scroll>

      <!-- Pager -->
      <Pager
        class="shrink-0 px-3 py-2"
        :page="page"
        :total-pages="totalPages"
        :disabled="isFetchingAudit"
        @change="goToPage"
      />
    </div>
  </DockedPanel>
</template>
