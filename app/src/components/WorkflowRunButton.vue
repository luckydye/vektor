<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import { cancelIcon, playCircleFilledIcon, spinnerIcon } from "~/src/assets/icons.ts";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const starting = ref(false);
const cancelling = ref(false);
const latestRunId = ref<string | null>(null);
const latestRunStatus = ref<string | null>(null);
let unsubscribe: (() => void) | null = null;

const isActiveRun = computed(
  () => latestRunStatus.value === "running" || latestRunStatus.value === "pending",
);

async function refreshLatestRun() {
  const latest = await api.workflows.getLatestRun(props.spaceId, props.documentId);
  latestRunId.value = latest?.runId ?? null;
  latestRunStatus.value = latest?.status ?? null;
}

async function startRun() {
  starting.value = true;
  try {
    const { runId } = await api.workflows.startRun(props.spaceId, props.documentId, {});
    latestRunId.value = runId;
    latestRunStatus.value = "running";
  } finally {
    starting.value = false;
  }
}

async function cancelRun() {
  if (!latestRunId.value || cancelling.value) return;
  cancelling.value = true;
  try {
    await api.workflows.cancelRun(props.spaceId, latestRunId.value);
    await refreshLatestRun();
  } finally {
    cancelling.value = false;
  }
}

onMounted(async () => {
  await refreshLatestRun();
  // Keep the run/cancel state in sync without polling.
  unsubscribe = api.subscribeToTopics(
    props.spaceId,
    [realtimeTopics.workflowRuns],
    () => {
      void refreshLatestRun();
    },
  );
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <button
    v-if="isActiveRun"
    type="button"
    class="inline-flex items-center gap-2 px-3 py-1.5 text-size-medium font-medium rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    :disabled="cancelling"
    @click="cancelRun"
  >
    <div
      v-if="cancelling"
      class="svg-icon w-3.5 h-3.5 animate-spin"
      v-html="spinnerIcon"
    />
    <div v-else class="svg-icon w-3.5 h-3.5" v-html="cancelIcon" />
    {{ cancelling ? "Cancelling…" : "Cancel" }}
  </button>
  <button
    v-else
    type="button"
    class="inline-flex items-center gap-2 px-3 py-1.5 text-size-medium font-medium rounded-md bg-neutral-900 dark:bg-neutral-100 text-white hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    :disabled="starting"
    @click="startRun"
  >
    <div v-if="starting" class="svg-icon w-3.5 h-3.5 animate-spin" v-html="spinnerIcon" />
    <div v-else class="svg-icon w-3.5 h-3.5" v-html="playCircleFilledIcon" />
    {{ starting ? "Starting…" : "Run Workflow" }}
  </button>
</template>
