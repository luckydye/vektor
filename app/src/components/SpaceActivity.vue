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
import { onMounted, ref } from "vue";
import { type AuditLog, api } from "../api/client.ts";
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

async function fetchActivities() {
  try {
    isLoading.value = true;
    error.value = null;

    const [logsData, usersData] = await Promise.all([
      api.auditLogs.get(props.spaceId, { limit: props.limit }),
      fetch(`/api/v1/users?spaceId=${encodeURIComponent(props.spaceId)}`).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch users");
        return r.json();
      }),
    ]);

    // Filter out ACL permission events
    activities.value = logsData.auditLogs.filter(
      (log) => log.event !== "acl_grant" && log.event !== "acl_revoke",
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

function getUser(userId?: string | null): User | undefined {
  if (!userId) return undefined;
  return users.value.get(userId) ?? undefined;
}

function getUserName(userId?: string | null): string {
  if (!userId) return "Unknown user";
  const user = users.value.get(userId);
  return user?.name || user?.email || userId;
}

function getDocumentName(docId: string): string {
  if (docId === props.spaceId) return "Home";
  const doc = documents.value.get(docId);
  return doc?.slug || "Unknown document";
}

onMounted(() => {
  fetchActivities();
});
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
