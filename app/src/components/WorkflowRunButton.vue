<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  closeXIcon,
  playCircleFilledIcon,
  spinnerQuarterIcon,
} from "~/src/assets/icons.ts";
import { api } from "../api/client.ts";
import { realtimeTopics } from "../utils/realtime.ts";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

type WorkflowNodeDef = {
  jobId: string;
  extensionId: string;
  inputs: { key: string; value: string }[];
};

type WorkflowInputMapping = { inputKey: string; alias: string };

const workflowDef = ref<Record<string, WorkflowNodeDef>>({});
const starting = ref(false);
const cancelling = ref(false);
const showInputsDialog = ref(false);
const inputValues = ref<Record<string, string>>({});
const latestRunId = ref<string | null>(null);
const latestRunStatus = ref<string | null>(null);
let unsubscribe: (() => void) | null = null;

const isActiveRun = computed(
  () => latestRunStatus.value === "running" || latestRunStatus.value === "pending",
);

const workflowInputMappings = computed((): WorkflowInputMapping[] => {
  const inputsNode = Object.values(workflowDef.value).find(
    (n) => n.jobId === "workflow-inputs",
  );
  if (!inputsNode) return [];
  const mappingsInput = inputsNode.inputs.find((i) => i.key === "mappings");
  if (!mappingsInput?.value) return [];
  try {
    return JSON.parse(mappingsInput.value) as WorkflowInputMapping[];
  } catch {
    return [];
  }
});

async function refreshLatestRun() {
  const latest = await api.workflows.getLatestRun(props.spaceId, props.documentId);
  latestRunId.value = latest?.runId ?? null;
  latestRunStatus.value = latest?.status ?? null;
}

function openRunDialog() {
  if (workflowInputMappings.value.length === 0) {
    void startRun({});
    return;
  }
  inputValues.value = Object.fromEntries(
    workflowInputMappings.value.map((m) => [m.inputKey, ""]),
  );
  showInputsDialog.value = true;
}

async function startRun(runtimeInputs: Record<string, string>) {
  showInputsDialog.value = false;
  starting.value = true;
  try {
    const { runId } = await api.workflows.startRun(
      props.spaceId,
      props.documentId,
      runtimeInputs,
    );
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
  try {
    const doc = await api.document.get(props.spaceId, props.documentId);
    workflowDef.value = JSON.parse(doc.content ?? "{}");
  } catch {}
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
    class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    :disabled="cancelling"
    @click="cancelRun"
  >
    <div v-if="cancelling" class="svg-icon w-3.5 h-3.5 animate-spin" v-html="spinnerQuarterIcon" />
    <div v-else class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
    {{ cancelling ? "Cancelling…" : "Cancel" }}
  </button>
  <button
    v-else
    type="button"
    class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-neutral-900 dark:bg-neutral-100 text-white hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    :disabled="starting"
    @click="openRunDialog"
  >
    <div v-if="starting" class="svg-icon w-3.5 h-3.5 animate-spin" v-html="spinnerQuarterIcon" />
    <div v-else class="svg-icon w-3.5 h-3.5" v-html="playCircleFilledIcon" />
    {{ starting ? "Starting…" : "Run Workflow" }}
  </button>

  <!-- Run inputs dialog -->
  <div
    v-if="showInputsDialog"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="showInputsDialog = false"
  >
    <div class="bg-white dark:bg-neutral-100 rounded-lg shadow-xl p-6 w-full max-w-md">
      <h2 class="text-base font-semibold text-neutral-900 mb-4">Run Workflow</h2>
      <form @submit.prevent="startRun(inputValues)" class="space-y-4">
        <div v-for="mapping in workflowInputMappings" :key="mapping.inputKey" class="space-y-1">
          <label class="block text-sm font-medium text-neutral-700">{{ mapping.alias }}</label>
          <input
            v-model="inputValues[mapping.inputKey]"
            type="text"
            class="w-full rounded-md border border-neutral-300 bg-white dark:bg-neutral-50 text-neutral-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
            :placeholder="mapping.alias"
          />
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-3 py-1.5 text-sm font-medium rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50 transition-colors"
            @click="showInputsDialog = false"
          >Cancel</button>
          <button
            type="submit"
            class="px-3 py-1.5 text-sm font-medium rounded-md bg-neutral-900 dark:bg-neutral-100 text-white hover:bg-neutral-700 dark:hover:bg-neutral-300 transition-colors"
          >Run</button>
        </div>
      </form>
    </div>
  </div>
</template>
