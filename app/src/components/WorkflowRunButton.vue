<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { cancelIcon, playCircleFilledIcon, spinnerIcon } from "~/src/assets/icons.ts";
import Button from "./Button.vue";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const router = useRouter();

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
    // The workflow view follows the `run` query param, so pointing the URL at
    // the new run switches the view over to it.
    void router.replace({
      query: { ...router.currentRoute.value.query, run: runId },
      hash: "",
    });
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
  <Button v-if="isActiveRun" tone="danger" :disabled="cancelling" @click="cancelRun">
    <div
      class="icon"
      :class="{ 'animate-spin': cancelling }"
      v-html="cancelling ? spinnerIcon : cancelIcon"
    />
    <span>{{ cancelling ? "Cancelling…" : "Cancel" }}</span>
  </Button>
  <Button v-else :disabled="starting" @click="startRun">
    <div
      class="icon"
      :class="{ 'animate-spin': starting }"
      v-html="starting ? spinnerIcon : playCircleFilledIcon"
    />
    <span>{{ starting ? "Starting…" : "Run workflow" }}</span>
  </Button>
</template>
