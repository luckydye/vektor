<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import { ButtonSecondary } from "~/src/components/index.ts";
import {
  closeXIcon,
  playCircleFilledIcon,
  spinnerQuarterIcon,
} from "~/src/assets/icons.ts";

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
  <ButtonSecondary
    v-if="isActiveRun"
    :disabled="cancelling"
    @click="cancelRun"
  >
    <span class="inline-flex items-center gap-2">
      <div
        v-if="cancelling"
        class="svg-icon w-3.5 h-3.5 animate-spin"
        v-html="spinnerQuarterIcon"
      />
      <div v-else class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
      <span>{{ cancelling ? "Cancelling…" : "Cancel" }}</span>
    </span>
  </ButtonSecondary>
  <ButtonSecondary
    v-else
    :disabled="starting"
    @click="startRun"
  >
    <span class="inline-flex items-center gap-2">
      <div
        v-if="starting"
        class="svg-icon w-3.5 h-3.5 animate-spin"
        v-html="spinnerQuarterIcon"
      />
      <div v-else class="svg-icon w-3.5 h-3.5" v-html="playCircleFilledIcon" />
      <span>{{ starting ? "Starting…" : "Run Workflow" }}</span>
    </span>
  </ButtonSecondary>
</template>
