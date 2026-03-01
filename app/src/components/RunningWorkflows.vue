<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { api } from "../api/client.ts";

type WorkflowRun = {
  runId: string;
  documentId: string;
  documentSlug: string | null;
  documentTitle: string;
  status: string;
};

const props = defineProps<{
  spaceSlug: string;
  spaceId: string;
}>();

const runs = ref<WorkflowRun[]>([]);
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function fetchRuns() {
  const result = await api.workflows.listRunning(props.spaceId);
  runs.value = result;
}

onMounted(() => {
  fetchRuns();
  pollInterval = setInterval(fetchRuns, 3000);
});

onUnmounted(() => {
  if (pollInterval !== null) clearInterval(pollInterval);
});

function docHref(run: WorkflowRun): string {
  if (run.documentSlug) return `/${props.spaceSlug}/doc/${run.documentSlug}`;
  return `/${props.spaceSlug}`;
}
</script>

<template>
  <div v-if="runs.length > 0">
    <h2 class="text-lg font-semibold mb-3">Running Workflows</h2>
    <ul class="space-y-1">
      <li
        v-for="run in runs"
        :key="run.runId"
        class="flex items-center gap-2 text-sm py-1.5 px-3 rounded-md bg-neutral-50 border border-neutral-100"
      >
        <!-- Spinner for running, pulse for pending -->
        <span v-if="run.status === 'running'" class="flex-shrink-0">
          <svg class="w-3.5 h-3.5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </span>
        <span v-else class="flex-shrink-0 w-3.5 h-3.5 rounded-full bg-neutral-300 animate-pulse" />

        <a
          :href="docHref(run)"
          class="flex-1 truncate font-medium hover:underline"
        >{{ run.documentTitle }}</a>

        <span class="text-xs text-neutral-400 capitalize">{{ run.status }}</span>
      </li>
    </ul>
  </div>
</template>
