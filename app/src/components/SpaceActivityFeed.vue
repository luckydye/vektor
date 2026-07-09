<script setup lang="ts">
import { computed } from "vue";
import { type AuditLog, api } from "#api/client.ts";
import { chevronRightThinIcon, documentIcon } from "#assets/icons.ts";
import { useQuery } from "#composeables/query.ts";
import { useSpace } from "#composeables/useSpace.ts";
import {
  formatActivityTime,
  formatPropertyKey,
  getAuditEventLabel,
  hasPropertyChange,
} from "#utils/auditActivity.ts";
import { normalizeTimestamp, spacePath } from "#utils/utils.ts";

interface User {
  id: string;
  name: string;
  email: string;
  image?: string;
}

interface Document {
  id: string;
  slug: string;
  type?: string;
}

interface UserLike {
  name?: string;
  email?: string;
  image?: string | null;
}

interface CompactActivityGroup {
  id: string;
  userId: string | null;
  time: string | Date;
  items: AuditLog[];
  date: string;
}

interface CompactActivityBatch {
  id: string;
  docId: string;
  action: string;
  entries: AuditLog[];
}

const props = withDefaults(
  defineProps<{
    spaceId: string;
    limit?: number;
  }>(),
  {
    limit: 10,
  },
);

const { currentSpace } = useSpace();

const {
  data,
  isPending: isLoading,
  error: queryError,
} = useQuery({
  queryKey: computed(() => ["space_activity", props.spaceId, props.limit]),
  queryFn: async () => {
    const [logsData, usersData] = await Promise.all([
      api.auditLogs.get(props.spaceId, { limit: props.limit }),
      api.users.get(props.spaceId),
    ]);

    const activities = logsData.auditLogs.filter(
      (log) => log.event !== "acl_grant" && log.event !== "acl_revoke",
    );

    const usersMap = new Map<string, User>();
    for (const user of usersData) {
      usersMap.set(user.id, user);
    }

    const docIds = new Set<string>();
    for (const activity of activities) {
      if (activity.docId && activity.docId !== props.spaceId) {
        docIds.add(activity.docId);
      }
    }

    const docsMap = new Map<string, Document>();
    await Promise.all(
      Array.from(docIds).map(async (docId) => {
        try {
          const doc = await api.document.get(props.spaceId, docId);
          docsMap.set(docId, doc);
        } catch {
          // best-effort
        }
      }),
    );

    return { activities, usersMap, docsMap };
  },
});

const activities = computed(() => data.value?.activities ?? []);
const error = computed(() => queryError.value?.message ?? null);

function getUser(userId?: string | null): User | undefined {
  if (!userId) return undefined;
  return data.value?.usersMap.get(userId);
}

function getUserName(userId?: string | null): string {
  if (!userId) return "Unknown user";
  const user = data.value?.usersMap.get(userId);
  return user?.name || user?.email || userId;
}

function getDocumentName(docId: string): string {
  if (docId === props.spaceId) return "Home";
  return data.value?.docsMap.get(docId)?.slug ?? "Unknown document";
}

function getDocumentHref(docId: string): string | undefined {
  if (docId === props.spaceId) return spacePath(currentSpace.value?.slug, "/");
  const doc = data.value?.docsMap.get(docId);
  if (!doc?.slug) return undefined;
  return spacePath(currentSpace.value?.slug, `/doc/${doc.slug}`);
}

function getActivityDate(entry: AuditLog): string {
  return normalizeTimestamp(entry.createdAt as string).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getActivityBucketLabel(dateString: string | Date): string {
  try {
    const date = normalizeTimestamp(dateString as string);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor(
      (startOfToday.getTime() - startOfDate.getTime()) / 86400000,
    );

    if (diffDays === 0) return formatActivityTime(date);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
  } catch {
    return String(dateString);
  }
}

function getCardUser(userId: string | null): UserLike | undefined {
  return getUser(userId);
}

function getCardUserInitials(userId: string | null): string {
  const user = getCardUser(userId);
  const displayName = user?.name || user?.email || getUserName(userId);
  if (!displayName) return "?";

  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return displayName[0]?.toUpperCase() ?? "?";
}

function getEntryAction(entry: AuditLog): string {
  const actions: Record<string, string> = {
    publish: "published",
    unpublish: "unpublished",
    delete: "deleted",
    archive: "archived",
    create: "created",
    restore: "restored",
    lock: "locked",
    unlock: "unlocked",
    save: "edited",
    property_update: "edited",
    property_delete: "edited",
  };

  return actions[entry.event] ?? getAuditEventLabel(entry.event).toLowerCase();
}

function getCompactActivityBatches(items: AuditLog[]): CompactActivityBatch[] {
  const batches: CompactActivityBatch[] = [];
  const batchMap = new Map<string, CompactActivityBatch>();

  for (const entry of items) {
    if (entry.event === "view") continue;

    const action = getEntryAction(entry);
    const key = `${entry.docId}:${action}`;
    let batch = batchMap.get(key);

    if (!batch) {
      batch = { id: key, docId: entry.docId, action, entries: [] };
      batchMap.set(key, batch);
      batches.push(batch);
    }

    batch.entries.push(entry);
  }

  return batches;
}

function getEntryChangeLabel(entry: AuditLog): string | null {
  if (hasPropertyChange(entry)) return formatPropertyKey(entry.details?.propertyKey);

  const labels: Record<string, string> = {
    save: "Content",
    publish: "Page published",
    unpublish: "Page unpublished",
    create: "Page created",
    delete: "Page deleted",
    archive: "Page archived",
    restore: "Page restored",
    lock: "Page locked",
    unlock: "Page unlocked",
  };

  return labels[entry.event] ?? null;
}

function getBatchChanges(batch: CompactActivityBatch): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const entry of batch.entries) {
    const label = getEntryChangeLabel(entry);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  return labels;
}

function getBatchChangeCount(batch: CompactActivityBatch): number {
  return Math.max(getBatchChanges(batch).length, batch.entries.length);
}

function getChangeCountLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

function activityTimeMs(dateString: string | Date): number {
  try {
    return normalizeTimestamp(dateString as string).getTime();
  } catch {
    return 0;
  }
}

const activityGroups = computed((): CompactActivityGroup[] => {
  const groups: CompactActivityGroup[] = [];
  let groupIndex = 0;

  for (const entry of activities.value) {
    const date = getActivityDate(entry);
    const last = groups[groups.length - 1];
    const userId = entry.userId ?? null;
    const sameUser = last && last.userId === userId;
    const sameDate = last && last.date === date;
    const sameActivityWindow =
      last &&
      Math.abs(activityTimeMs(last.time) - activityTimeMs(entry.createdAt)) <= 900000;

    if (sameUser && sameDate && sameActivityWindow) {
      last.items.push(entry);
    } else {
      groups.push({
        id: `group-${groupIndex++}`,
        userId,
        time: entry.createdAt,
        items: [entry],
        date,
      });
    }
  }

  return groups;
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-size-label">Space Activity</h2>
    </div>

    <div v-if="error" class="text-red-600 p-4 border border-red-200 rounded-sm bg-red-50">
      {{ error }}
    </div>

    <div v-else-if="isLoading" class="space-y-5">
      <div v-for="i in 3" :key="`skeleton-${i}`" class="space-y-2 animate-pulse">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-neutral-200 shrink-0" />
          <div class="flex items-center gap-2">
            <div class="h-3.5 bg-neutral-200 rounded-sm w-24" />
            <div class="h-3 bg-neutral-200 rounded-sm w-16" />
            <div class="h-3 bg-neutral-200 rounded-sm w-20" />
          </div>
        </div>
        <div class="ml-12 space-y-1.5">
          <div class="h-6 bg-neutral-100 rounded-sm w-56" />
          <div v-if="i === 1" class="h-6 bg-neutral-100 rounded-sm w-44" />
        </div>
      </div>
    </div>

    <div v-else-if="activities.length === 0" class="text-center py-8 text-neutral-400">
      No recent activity
    </div>

    <div v-else class="@container space-y-4">
      <template v-for="(group, index) in activityGroups" :key="group.id">
        <div
          v-if="index === 0 || getActivityBucketLabel(activityGroups[index - 1].time) !== getActivityBucketLabel(group.time)"
          class="px-1 text-size-small font-medium text-neutral-500"
        >
          {{ getActivityBucketLabel(group.time) }}
        </div>

        <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
        <a
          v-for="batch in getCompactActivityBatches(group.items)"
          :key="batch.id"
          :href="getDocumentHref(batch.docId)"
          class="block rounded-lg border border-neutral-100 bg-neutral-10 px-3.5 py-3 transition-colors hover:bg-neutral-50"
        >
          <div
            class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 @md:grid-cols-[minmax(0,1fr)_minmax(10rem,42%)_auto]"
          >
            <div class="flex min-w-0 items-center gap-3">
              <div
                class="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-neutral-200 text-neutral-700"
              >
                <img
                  v-if="getCardUser(group.userId)?.image"
                  :src="getCardUser(group.userId)?.image ?? undefined"
                  :alt="getUserName(group.userId)"
                  class="h-full w-full object-cover"
                >
                <div
                  v-else
                  class="flex h-full w-full items-center justify-center text-size-medium font-semibold leading-none"
                >
                  {{ getCardUserInitials(group.userId) }}
                </div>
              </div>

              <div class="min-w-0">
                <div
                  class="flex min-w-0 items-baseline gap-1 text-size-medium leading-medium"
                >
                  <span class="font-semibold text-neutral-900">
                    {{ getUserName(group.userId) }}
                  </span>
                  <span class="shrink-0 text-neutral-700">{{ batch.action }}</span>
                </div>
                <div class="mt-0.5 text-size-small font-medium text-neutral-500">
                  {{ getChangeCountLabel(getBatchChangeCount(batch)) }}
                </div>
              </div>
            </div>

            <div
              class="col-start-1 row-start-2 flex min-w-0 items-center gap-3 @md:col-auto @md:row-auto"
            >
              <div
                class="svg-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-100 p-2 text-neutral-500"
                v-html="documentIcon"
              />
              <div class="min-w-0 truncate text-size-medium text-neutral-700">
                {{ getDocumentName(batch.docId) }}
              </div>
            </div>

            <div
              class="svg-icon col-start-2 row-span-2 h-5 w-5 shrink-0 text-neutral-400 @md:col-auto @md:row-auto"
              v-html="chevronRightThinIcon"
            />
          </div>
        </a>
      </template>
    </div>
  </div>
</template>
