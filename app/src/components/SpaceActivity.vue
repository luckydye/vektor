<!--
SpaceActivity Component

Displays recent activity from the audit log for a space. Shows user actions like
document creation, edits, publishing, permissions changes, etc.

Props:
  - spaceId: The ID of the space to show activity for
  - limit: Maximum number of activity entries to fetch (default: 10)

Features:
  - Groups activities by date for better readability
  - Shows color-coded indicators for different event types
  - Displays relative time ("5 minutes ago") for recent events
  - Fetches and displays user names and document names
  - Add websocket support for real-time activity updates

Usage:
  import SpaceActivity from "./SpaceActivity.vue";

  <SpaceActivity client:load spaceId="space-123" limit={15} />
-->

<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { normalizeTimestamp } from "../utils/utils.ts";

interface AuditLogEntry {
  id: number;
  docId: string;
  revisionId?: number;
  userId?: string;
  event: string;
  details?: {
    message?: string;
    permission?: string;
  } | null;
  createdAt: string;
}

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

interface Props {
  spaceId: string;
  limit?: number;
}

const props = withDefaults(defineProps<Props>(), {
  limit: 10,
});

const activities = ref<AuditLogEntry[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);
const users = ref<Map<string, User>>(new Map());
const documents = ref<Map<string, Document>>(new Map());

const eventLabels: Record<string, string> = {
  view: "viewed",
  save: "made changes to",
  publish: "published",
  unpublish: "unpublished",
  restore: "restored",
  delete: "deleted",
  create: "created",
  lock: "locked",
  unlock: "unlocked",
  webhook_success: "successfully delivered webhook for",
  webhook_failed: "failed to deliver webhook for",
};

const eventColors: Record<string, string> = {
  create: "bg-green-500",
  save: "bg-blue-500",
  publish: "bg-purple-500",
  delete: "bg-red-500",
  lock: "bg-orange-500",
  unlock: "bg-green-500",
  webhook_success: "bg-green-500",
  webhook_failed: "bg-red-500",
  default: "bg-neutral-500",
};

async function fetchActivities() {
  try {
    isLoading.value = true;
    error.value = null;

    const [logsResponse, usersResponse] = await Promise.all([
      fetch(`/api/v1/spaces/${props.spaceId}/audit-logs?limit=${props.limit}`),
      fetch("/api/v1/users"),
    ]);

    if (!logsResponse.ok) {
      throw new Error("Failed to fetch activity logs");
    }

    if (!usersResponse.ok) {
      throw new Error("Failed to fetch users");
    }

    const logsData = await logsResponse.json();
    const usersData = await usersResponse.json();

    // Filter out ACL permission events
    activities.value = (logsData.auditLogs || []).filter(
      (log: AuditLogEntry) => log.event !== "acl_grant" && log.event !== "acl_revoke",
    );

    const usersMap = new Map<string, User>();
    for (const user of usersData) {
      usersMap.set(user.id, user);
    }
    users.value = usersMap;

    await fetchDocuments();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unknown error";
    console.error("Error fetching activities:", err);
  } finally {
    isLoading.value = false;
  }
}

async function fetchDocuments() {
  const docIds = new Set<string>();

  for (const activity of activities.value) {
    if (activity.docId && activity.docId !== props.spaceId) {
      docIds.add(activity.docId);
    }
  }

  const docPromises = Array.from(docIds).map(async (docId) => {
    try {
      const response = await fetch(`/api/v1/spaces/${props.spaceId}/documents/${docId}`);
      if (response.ok) {
        const data = await response.json();
        documents.value.set(docId, data.document);
      }
    } catch (err) {
      console.error(`Failed to fetch document ${docId}:`, err);
    }
  });

  await Promise.all(docPromises);
}

function getUserName(userId?: string): string {
  if (!userId) return "Unknown user";
  const user = users.value.get(userId);
  return user?.name || user?.email || userId;
}

function getDocumentName(docId: string): string {
  if (docId === props.spaceId) return "Home";
  const doc = documents.value.get(docId);
  return doc?.slug || "Unknown document";
}

function formatEventDescription(activity: AuditLogEntry): string {
  const userName = getUserName(activity.userId);
  const eventLabel = eventLabels[activity.event] || activity.event;
  const docName = getDocumentName(activity.docId);

  if (activity.details?.message) {
    return `${userName} ${eventLabel} ${docName}`;
  }

  return `${userName} ${eventLabel} ${docName}`;
}

function getEventColor(event: string): string {
  return eventColors[event] || eventColors.default;
}

function formatTime(dateString: string): string {
  try {
    const date = normalizeTimestamp(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? "minute" : "minutes"} ago`;
    if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
    if (diffDays < 30) return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;

    return date.toLocaleDateString();
  } catch {
    return dateString;
  }
}

const groupedActivities = computed(() => {
  const groups: { date: string; items: AuditLogEntry[] }[] = [];
  let currentDate = "";
  let currentGroup: AuditLogEntry[] = [];

  for (const activity of activities.value) {
    const activityDate = normalizeTimestamp(activity.createdAt).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    if (activityDate !== currentDate) {
      if (currentGroup.length > 0) {
        groups.push({ date: currentDate, items: currentGroup });
      }
      currentDate = activityDate;
      currentGroup = [activity];
    } else {
      currentGroup.push(activity);
    }
  }

  if (currentGroup.length > 0) {
    groups.push({ date: currentDate, items: currentGroup });
  }

  return groups;
});

onMounted(() => {
  fetchActivities();
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-2xl font-bold">Recent Activity</h2>
    </div>

    <div v-if="error" class="text-red-600 p-4 border border-red-200 rounded bg-red-50">
      {{ error }}
    </div>

    <div v-else-if="isLoading" class="space-y-6">
      <div class="space-y-3">
        <div class="text-xs font-semibold text-neutral-900 uppercase tracking-wide sticky top-0 py-2 h-4 bg-neutral-200 rounded w-32 animate-pulse" />
        <div class="space-y-1">
          <div v-for="i in 5" :key="`skeleton-${i}`" class="flex items-start gap-3 p-3 rounded-lg animate-pulse">
            <div class="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-neutral-200" />
            <div class="flex-1 min-w-0 space-y-2">
              <div class="h-4 bg-neutral-200 rounded w-3/4" />
              <div class="h-3 bg-neutral-200 rounded w-1/4" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="activities.length === 0" class="text-center py-8 text-neutral">
      No recent activity
    </div>

    <div v-else class="space-y-6">
      <div v-for="group in groupedActivities" :key="group.date" class="space-y-3">
        <div class="text-xs font-semibold text-neutral-900 uppercase tracking-wide sticky top-0 py-2">
          {{ group.date }}
        </div>
        <div class="space-y-0.5">
          <div
            v-for="activity in group.items"
            :key="activity.id"
            class="flex items-start gap-3 p-3 rounded-lg hover:bg-neutral-300 transition-colors group"
          >
            <div
              class="flex-shrink-0 w-2 h-2 mt-1.5 rounded-full"
              :class="getEventColor(activity.event)"
            />
            <div class="flex-1 min-w-0 flex justify-between flex-wrap">
              <p class="text-sm text-neutral-900">
                {{ formatEventDescription(activity) }}
              </p>
              <p class="text-xs text-neutral-900">
                {{ formatTime(activity.createdAt) }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
