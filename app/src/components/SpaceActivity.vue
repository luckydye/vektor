<!--
SpaceActivity Component

Displays recent activity from the audit log for a space. Shows user actions like
document creation, edits, publishing, permissions changes, property updates, etc.

Props:
  - spaceId: The ID of the space to show activity for
  - limit: Maximum number of activity entries to fetch (default: 10)

Features:
  - Groups consecutive activities by the same user into one card
  - A new group starts when a different user acts
  - Date separators appear between groups when the date changes
  - Displays property changes as "Property: oldValue → newValue"
  - Fetches and displays user names and document names
-->

<script setup lang="ts">
import { computed } from "vue";
import { type AuditLog, api } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import ActivityFeed from "./ActivityFeed.vue";

type AuditLogEntry = AuditLog;

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

const props = withDefaults(defineProps<{
  spaceId: string;
  limit?: number;
}>(), {
  limit: 10,
});

const { data, isPending: isLoading, error: queryError } = useQuery({
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
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-size-title">Recent Activity</h2>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-red-600 p-4 border border-red-200 rounded-sm bg-red-50">
      {{ error }}
    </div>

    <!-- Loading skeleton -->
    <div v-else-if="isLoading" class="space-y-5">
      <div v-for="i in 3" :key="`skeleton-${i}`" class="space-y-2 animate-pulse">
        <!-- Group header skeleton -->
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-neutral-200 shrink-0" />
          <div class="flex items-center gap-2">
            <div class="h-3.5 bg-neutral-200 rounded-sm w-24" />
            <div class="h-3 bg-neutral-200 rounded-sm w-16" />
            <div class="h-3 bg-neutral-200 rounded-sm w-20" />
          </div>
        </div>
        <!-- Change rows skeleton -->
        <div class="ml-12 space-y-1.5">
          <div class="h-6 bg-neutral-100 rounded-sm w-56" />
          <div v-if="i === 1" class="h-6 bg-neutral-100 rounded-sm w-44" />
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="activities.length === 0" class="text-center py-8 text-neutral-400">
      No recent activity
    </div>

    <!-- Activity feed -->
    <ActivityFeed
      v-else
      :entries="activities"
      :get-user-name="getUserName"
      :get-user="getUser"
      :get-document-name="getDocumentName"
    />
  </div>
</template>
