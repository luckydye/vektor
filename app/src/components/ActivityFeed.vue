<!--
ActivityFeed Component

Renders audit-log entries grouped by consecutive same-user runs, YouTrack-style.
Each group shows the user's avatar, name, a summary of what they did, and relative time.
Property changes are rendered as "Property: old → new" pills.

Props:
  - entries:         AuditLog[] – the raw entries to display (pre-filtered by the parent)
  - getUserName:     (userId?) => string – resolves a display name for a user ID
  - getUser?:        (userId?) => UserLike | undefined – resolves avatar data; optional
  - getDocumentName?: (docId) => string – resolves a document label; optional

Slots:
  - #entry-actions="{ entry }" – optional per-entry action area (right side of each row).
    RevisionsSidebar uses this for the View / Diff / Copy / Publish popover.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { AuditLog } from "../api/client.ts";
import {
  formatActivityTime,
  formatPropertyKey,
  getAuditEventLabel,
  hasPropertyChange,
} from "../utils/auditActivity.ts";
import { normalizeTimestamp } from "../utils/utils.ts";
import Avatar from "./Avatar.vue";

interface UserLike {
  name?: string;
  email?: string;
  image?: string | null;
}

interface Props {
  entries: AuditLog[];
  getUserName: (userId?: string | null) => string;
  getUser?: (userId?: string | null) => UserLike | undefined;
  getDocumentName?: (docId: string) => string;
}

const props = defineProps<Props>();

interface ActivityGroup {
  id: string;
  userId: string | null;
  time: string | Date;
  items: AuditLog[];
  date: string;
}

function getActivityDate(entry: AuditLog): string {
  return normalizeTimestamp(entry.createdAt as string).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getGroupSummary(items: AuditLog[]): string {
  const uniqueEvents = new Set(items.map((i) => i.event));
  const docName = (docId: string) => props.getDocumentName?.(docId) ?? "";

  if (uniqueEvents.size === 1) {
    const event = [...uniqueEvents][0];
    const uniqueDocs = new Set(items.map((i) => i.docId));
    const label = getAuditEventLabel(event);
    if (uniqueDocs.size === 1) {
      const name = docName([...uniqueDocs][0]);
      return name ? `${label} ${name}` : label;
    }
    return `${label} ${uniqueDocs.size} documents`;
  }

  // Mixed event types
  const uniqueDocs = new Set(items.map((i) => i.docId));
  if (uniqueDocs.size === 1) {
    const name = docName([...uniqueDocs][0]);
    return name ? `Updated ${name}` : "Updated";
  }
  return `Made ${items.length} changes`;
}

/**
 * Returns true for events worth listing as individual rows inside a group.
 * save/view are fully captured by the group header so they're skipped.
 */
function isVerboseEvent(entry: AuditLog): boolean {
  return entry.event !== "save" && entry.event !== "view";
}

const activityGroups = computed((): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];
  let groupIndex = 0;

  for (const entry of props.entries) {
    const date = getActivityDate(entry);
    const last = groups[groups.length - 1];
    const sameUser = last && last.userId === (entry.userId ?? null);
    const sameDate = last && last.date === date;

    if (sameUser && sameDate) {
      last.items.push(entry);
    } else {
      groups.push({
        id: `group-${groupIndex++}`,
        userId: entry.userId ?? null,
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
  <div class="@container space-y-1">
    <template v-for="group in activityGroups" :key="group.id">

      <!-- User group card -->
      <!-- Default: block, header row (avatar inline) + entries full-width -->
      <!-- @md: flex, avatar as persistent left column -->
      <div class="px-2 pt-3 pb-2.5 rounded-lg @md:flex @md:gap-3 @md:items-start">

        <!-- Avatar: left column at @md only -->
        <div class="hidden @md:block shrink-0 pt-0.5">
          <Avatar
            :id="group.userId ?? undefined"
            :user="getUser?.(group.userId)"
            :size="34"
          />
        </div>

        <!-- Content -->
        <div class="flex-1 min-w-0 space-y-2">

          <!-- Group header: Name • Summary · time [optional action] -->
          <!-- At default the avatar lives inline here; hidden at @md -->
          <div class="flex items-center gap-2">
            <div class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 flex-1 min-w-0">
              <div class="@md:hidden shrink-0 self-center mr-0.5">
                <Avatar
                  :id="group.userId ?? undefined"
                  :user="getUser?.(group.userId)"
                  :size="28"
                />
              </div>
              <span class="text-sm font-semibold text-primary-600 leading-[1.7rem] @md:leading-[2.175rem]">
                {{ getUserName(group.userId) }}
              </span>
              <span class="text-neutral-300 select-none text-xs">•</span>
              <span class="text-sm text-neutral-600">{{ getGroupSummary(group.items) }}</span>
              <span class="text-neutral-300 select-none text-xs">·</span>
              <span class="text-xs text-neutral-400 whitespace-nowrap">
                {{ formatActivityTime(group.time) }}
              </span>
            </div>
            <!-- Action placed to the right of the date (e.g. revision ⋯ popover) -->
            <slot name="header-actions" :items="group.items" />
          </div>

          <!-- Per-entry rows -->
          <div class="space-y-1 ml-4 @md:ml-0">
            <template v-for="entry in group.items" :key="entry.id">
              <div class="flex items-start gap-2">

                <div class="flex-1 min-w-0 space-y-1">
                  <!-- Property change pill -->
                  <div
                    v-if="hasPropertyChange(entry)"
                    class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs bg-neutral-100 rounded-sm px-2.5 py-1.5 text-neutral-700"
                  >
                    <span class="font-medium text-neutral-500">
                      {{ formatPropertyKey(entry.details?.propertyKey) }}:
                    </span>
                    <span v-if="entry.details?.previousValue" class="text-neutral-500">
                      {{ entry.details.previousValue }}
                    </span>
                    <span v-else class="text-neutral-400 italic">—</span>
                    <span class="text-neutral-400 font-mono text-[11px]">→</span>
                    <span v-if="entry.event === 'property_delete'" class="text-red-500 italic">(removed)</span>
                    <span v-else-if="entry.details?.newValue" class="font-medium text-neutral-700">
                      {{ entry.details.newValue }}
                    </span>
                    <span v-else class="text-neutral-400 italic">—</span>
                  </div>

                  <!-- Non-property label: shown for all event types in
                       multi-item groups so the entry has visible content. -->
                  <div
                    v-else-if="group.items.length > 1"
                    class="flex items-center gap-1.5 text-xs text-neutral-500"
                  >
                    <span class="font-medium text-neutral-600">{{ getAuditEventLabel(entry.event) }}</span>
                    <span v-if="getDocumentName?.(entry.docId)">{{ getDocumentName(entry.docId) }}</span>
                    <!-- <template v-if="entry.details?.message && entry.event !== 'save'">
                        TODO: should be a detail expand area soemthing
                      <span class="text-neutral-300">·</span>
                      <span>{{ entry.details.message }}</span>
                    </template> -->
                  </div>
                </div>

                <!-- Optional per-entry action (e.g. revision popover) -->
                <slot name="entry-actions" :entry="entry" />

              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
