<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { AuditLog } from "#api/client.ts";
import {
  activityIcon,
  contextMenuMoreIcon,
  copyIcon,
  eyeIcon,
  pasteIcon,
  publishIcon,
  refreshIcon,
} from "#assets/icons.ts";
import { useAuditLogs } from "#composeables/useAuditLogs.ts";
import { useRevisions } from "#composeables/useRevisions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { findMemberUser, userDisplayName } from "#utils/userDisplay.ts";
import { normalizeTimestamp } from "#utils/utils.ts";
import DockedPanel from "./DockedPanel.vue";
import DocumentActivityFeed from "./DocumentActivityFeed.vue";
import PagerCursor from "./PagerCursor.vue";
import "@atrium-ui/elements/popover";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useMembers } from "#composeables/useMembers.ts";
import { useSync } from "#composeables/useSync.ts";
import { realtimeTopics } from "#realtime/protocol.ts";

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
  hasPrevPage: hasPrevAuditPage,
  hasNextPage: hasNextAuditPage,
  nextPage: nextAuditPage,
  prevPage: prevAuditPage,
} = useAuditLogs(props.documentId);

const { currentSpaceId } = useSpace();
const router = useRouter();
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

function getUser(userId?: string | null) {
  return findMemberUser(members.value, userId);
}

function getUserName(userId?: string | null): string {
  return userDisplayName(getUser(userId), userId);
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

    void router.replace({
      query: { ...router.currentRoute.value.query, revision: String(revisionId) },
    });

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

function copyRevisionLink(revisionId: number | null | undefined) {
  if (!revisionId) return;

  const route = router.resolve({
    path: router.currentRoute.value.path,
    query: { ...router.currentRoute.value.query, revision: String(revisionId) },
  });
  navigator.clipboard.writeText(new URL(route.href, window.location.origin).href);
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
  const { revision: _removed, ...query } = router.currentRoute.value.query;
  void router.replace({ query });
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
  <DockedPanel
    id="revisions"
    title="Document Activity"
    default-side="right"
    :default-width="420"
  >
    <div class="relative flex flex-col h-full">
      <!-- Error State -->
      <div
        v-if="auditError"
        class="mx-4 mt-4 p-3 text-size-medium text-red-700 bg-red-50 border border-red-200 rounded-sm"
      >
        {{ auditError }}
      </div>

      <!-- Loading State -->
      <div
        v-if="(isLoadingHistory || isLoadingAudit) && sortedEntries.length === 0"
        class="flex-1 flex items-center justify-center"
      >
        <div class="text-center">
          <div
            class="svg-icon w-8 h-8 mx-auto mb-2 text-neutral-400 animate-spin"
            v-html="refreshIcon"
          />
          <p class="text-size-medium text-neutral-600">Loading history...</p>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-else-if="sortedEntries.length === 0"
        class="flex-1 flex items-center justify-center"
      >
        <div class="text-center px-4">
          <div
            class="svg-icon w-12 h-12 mx-auto mb-3 text-neutral-300"
            v-html="activityIcon"
          />
          <p class="font-medium text-neutral-600">No activity yet</p>
          <p class="text-size-medium text-neutral-500 mt-1">
            Activity will appear here as you work
          </p>
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
                    type="button"
                    slot="trigger"
                    class="inline-flex items-center justify-center w-7 h-7 rounded-sm hover:bg-neutral-200 transition-colors"
                    title="Revision actions"
                  >
                    <div
                      class="svg-icon w-[12px] h-[18px] text-neutral-500"
                      v-html="contextMenuMoreIcon"
                    />
                  </button>

                  <a-popover class="group" placements="bottom-end">
                    <div
                      class="revision-context-menu w-max py-1 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100"
                    >
                      <div
                        class="revision-context-panel min-w-[224px] origin-top-right scale-95 rounded-lg border border-neutral-100 bg-background p-5xs shadow-large transition-transform duration-150 group-[&[enabled]]:scale-100"
                      >
                        <button
                          type="button"
                          @click="e => { exitPopover(e); viewRevision(primaryRevisionEntry(items)!.revisionId); }"
                          class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-size-normal text-neutral-900 transition-colors hover:bg-primary-50 active:bg-primary-100"
                        >
                          <div class="svg-icon w-4 h-4 flex-none" v-html="eyeIcon" />
                          View Revision
                        </button>
                        <button
                          type="button"
                          @click="e => { exitPopover(e); showDiff(primaryRevisionEntry(items)!); }"
                          class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-size-normal text-neutral-900 transition-colors hover:bg-primary-50 active:bg-primary-100"
                        >
                          <div class="svg-icon w-4 h-4 flex-none" v-html="pasteIcon" />
                          Show Diff
                        </button>
                        <button
                          type="button"
                          @click="e => { exitPopover(e); copyRevisionLink(primaryRevisionEntry(items)!.revisionId); }"
                          class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-size-normal text-neutral-900 transition-colors hover:bg-primary-50 active:bg-primary-100"
                        >
                          <div class="svg-icon w-4 h-4 flex-none" v-html="copyIcon" />
                          Copy Link
                        </button>
                        <button
                          type="button"
                          v-if="!isPublishedEntry(primaryRevisionEntry(items)!) && !isSuggestionEntry(primaryRevisionEntry(items)!)"
                          @click="e => { exitPopover(e); publishRevisionAction(primaryRevisionEntry(items)!.revisionId); }"
                          class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-size-normal text-neutral-900 transition-colors hover:bg-primary-50 active:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-50"
                          :disabled="isPublishing"
                        >
                          <div class="svg-icon w-4 h-4 flex-none" v-html="publishIcon" />
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
                >Published</span
              >
              <span
                v-else-if="isSuggestionEntry(entry)"
                class="shrink-0 self-center px-1.5 py-px text-[10px] font-medium uppercase tracking-wide rounded-sm border border-amber-200 text-amber-600 bg-amber-50"
                >{{ revisionStatusOf(entry) === "applied" ? "Applied" : "Suggestion" }}</span
              >
            </template>
          </DocumentActivityFeed>
        </div>
      </wiki-scroll>

      <!-- Pager -->
      <PagerCursor
        class="shrink-0 px-3 py-2"
        :has-prev-page="hasPrevAuditPage"
        :has-next-page="hasNextAuditPage"
        :disabled="isFetchingAudit"
        @prev="prevAuditPage"
        @next="nextAuditPage"
      />
    </div>
  </DockedPanel>
</template>
