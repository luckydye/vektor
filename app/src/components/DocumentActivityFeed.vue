<script setup lang="ts">
import { computed, ref } from "vue";
import type { AuditLog } from "#api/client.ts";
import { checkCircleOutlineIcon, editOutlineIcon, plusIcon } from "#assets/icons.ts";
import {
  formatActivityTime,
  formatPropertyKey,
  getAuditEventLabel,
  hasPropertyChange,
} from "#utils/auditActivity.ts";
import { normalizeTimestamp } from "#utils/utils.ts";

interface UserLike {
  name?: string;
  email?: string;
  image?: string | null;
}

interface DocumentActivityGroup {
  id: string;
  userId: string | null;
  time: string | Date;
  items: AuditLog[];
  date: string;
}

const props = defineProps<{
  entries: AuditLog[];
  getUserName: (userId?: string | null) => string;
  getUser?: (userId?: string | null) => UserLike | undefined;
}>();

const expandedGroups = ref(new Set<string>());

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
  return props.getUser?.(userId);
}

function getCardUserInitials(userId: string | null): string {
  const user = getCardUser(userId);
  const displayName = user?.name || user?.email || props.getUserName(userId);
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

function getGroupAction(items: AuditLog[]): string {
  return items[0] ? getEntryAction(items[0]) : "updated";
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

function getDocumentActivityIcon(entry: AuditLog): string {
  if (entry.event === "publish") return checkCircleOutlineIcon;
  return editOutlineIcon;
}

function getDocumentEntries(group: DocumentActivityGroup): AuditLog[] {
  const entries = group.items.filter(isVisibleDocumentEntry);
  return isGroupExpanded(group.id) ? entries : entries.slice(0, 3);
}

function getHiddenDocumentEntryCount(items: AuditLog[]): number {
  return Math.max(0, items.filter(isVisibleDocumentEntry).length - 3);
}

function getMoreChangesLabel(count: number): string {
  return `${count} more ${count === 1 ? "change" : "changes"}`;
}

function isVisibleDocumentEntry(entry: AuditLog): boolean {
  return entry.event !== "view";
}

function isGroupExpanded(groupId: string): boolean {
  return expandedGroups.value.has(groupId);
}

function toggleGroup(groupId: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(groupId)) {
    next.delete(groupId);
  } else {
    next.add(groupId);
  }
  expandedGroups.value = next;
}

function hasDocumentDelta(entry: AuditLog): boolean {
  return (
    hasPropertyChange(entry) &&
    (entry.details?.previousValue !== undefined ||
      entry.details?.newValue !== undefined ||
      entry.event === "property_delete")
  );
}

function activityMinute(entry?: AuditLog): string {
  if (!entry) return "";
  try {
    const date = normalizeTimestamp(entry.createdAt as string);
    date.setSeconds(0, 0);
    return date.toISOString();
  } catch {
    return String(entry.createdAt);
  }
}

function getDocumentBatchKey(entry: AuditLog | undefined, userId: string | null): string {
  if (!entry) return "";
  return [
    userId,
    entry.docId,
    getEntryAction(entry),
    entry.revisionId ?? activityMinute(entry),
  ].join(":");
}

const activityGroups = computed((): DocumentActivityGroup[] => {
  const groups: DocumentActivityGroup[] = [];
  let groupIndex = 0;

  for (const entry of props.entries) {
    const date = getActivityDate(entry);
    const last = groups[groups.length - 1];
    const userId = entry.userId ?? null;
    const sameUser = last && last.userId === userId;
    const sameDate = last && last.date === date;
    const sameBatch =
      last &&
      getDocumentBatchKey(last.items[0], last.userId) ===
        getDocumentBatchKey(entry, userId);

    if (sameUser && sameDate && sameBatch) {
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
  <div class="@container space-y-4">
    <template v-for="(group, index) in activityGroups" :key="group.id">
      <div
        v-if="index === 0 || getActivityBucketLabel(activityGroups[index - 1].time) !== getActivityBucketLabel(group.time)"
        class="px-1 text-size-small font-medium text-neutral-500"
      >
        {{ getActivityBucketLabel(group.time) }}
      </div>

      <article class="rounded-lg border border-neutral-100 bg-neutral-10 px-3 py-3">
        <div class="flex items-start gap-3">
          <div
            class="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-neutral-200 text-neutral-700"
          >
            <img
              v-if="getCardUser(group.userId)?.image"
              :src="getCardUser(group.userId)?.image ?? undefined"
              :alt="getUserName(group.userId)"
              class="h-full w-full object-cover"
            >
            <div
              v-else
              class="flex h-full w-full items-center justify-center text-size-small font-semibold leading-none"
            >
              {{ getCardUserInitials(group.userId) }}
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <div
                class="flex min-w-0 flex-1 items-baseline gap-1 text-size-small leading-small"
              >
                <span class="truncate font-semibold text-neutral-900">
                  {{ getUserName(group.userId) }}
                </span>
                <span class="shrink-0 text-neutral-700"
                  >{{ getGroupAction(group.items) }}</span
                >
              </div>
              <slot name="header-actions" :items="group.items" />
            </div>

            <div class="mt-2.5 space-y-2">
              <div
                v-for="entry in getDocumentEntries(group)"
                :key="entry.id"
                class="flex min-w-0 items-center gap-3"
              >
                <div
                  class="svg-icon h-4 w-4 shrink-0 text-neutral-400"
                  v-html="getDocumentActivityIcon(entry)"
                />
                <div
                  class="min-w-0 flex-1 truncate text-size-small font-medium text-neutral-600"
                >
                  {{ getEntryChangeLabel(entry) ?? getAuditEventLabel(entry.event) }}
                </div>

                <div
                  v-if="hasDocumentDelta(entry)"
                  class="flex max-w-[55%] shrink-0 items-center gap-1.5 rounded-md bg-neutral-50 px-2 py-0.5 text-size-small text-neutral-500"
                >
                  <span
                    v-if="entry.details?.previousValue"
                    class="min-w-0 max-w-[16ch] truncate"
                    :title="entry.details.previousValue"
                  >
                    {{ entry.details.previousValue }}
                  </span>
                  <span v-else class="text-neutral-400">—</span>
                  <span class="font-mono text-size-extra-small text-neutral-400">→</span>
                  <span
                    v-if="entry.event === 'property_delete'"
                    class="shrink-0 text-red-500"
                  >
                    removed
                  </span>
                  <span
                    v-else-if="entry.details?.newValue"
                    class="min-w-0 max-w-[16ch] truncate text-neutral-700"
                    :title="entry.details.newValue"
                  >
                    {{ entry.details.newValue }}
                  </span>
                  <span v-else class="text-neutral-400">—</span>
                </div>

                <slot name="entry-actions" :entry="entry" />
              </div>

              <button
                v-if="getHiddenDocumentEntryCount(group.items) > 0"
                type="button"
                class="flex items-center gap-3 text-size-small font-medium text-neutral-500 hover:text-neutral-700"
                @click="toggleGroup(group.id)"
              >
                <div
                  class="svg-icon h-4 w-4 shrink-0 text-neutral-400 transition-transform"
                  :class="isGroupExpanded(group.id) ? 'rotate-45' : ''"
                  v-html="plusIcon"
                />
                <span>
                  {{ isGroupExpanded(group.id)
                      ? "Show fewer changes"
                      : getMoreChangesLabel(getHiddenDocumentEntryCount(group.items)) }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </article>
    </template>
  </div>
</template>
