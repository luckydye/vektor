<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api } from "../api/client.ts";
import type { WorkflowRunStatus, WorkflowNodeState } from "../api/ApiClient.ts";

const props = defineProps<{
  documentId: string;
  spaceId: string;
  spaceSlug: string;
}>();

type RunSummary = {
  runId: string;
  status: string;
  createdAt: string;
};

const runList = ref<RunSummary[]>([]);
const selectedRunId = ref<string | null>(null);
const selectedRunDetail = ref<WorkflowRunStatus | null>(null);
const starting = ref(false);
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function fetchRuns() {
  const all = await api.workflows.listRuns(props.spaceId);
  runList.value = all
    .filter((r) => r.documentId === props.documentId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function fetchSelectedRunDetail() {
  if (!selectedRunId.value) return;
  selectedRunDetail.value = await api.workflows.getRun(props.spaceId, selectedRunId.value);
}

async function selectRun(runId: string) {
  selectedRunId.value = runId;
  await fetchSelectedRunDetail();
}

async function startRun() {
  starting.value = true;
  try {
    const { runId } = await api.workflows.startRun(props.spaceId, props.documentId);
    await fetchRuns();
    await selectRun(runId);
  } finally {
    starting.value = false;
  }
}

const isActiveRun = computed(() =>
  runList.value.some((r) => r.status === "running" || r.status === "pending"),
);

onMounted(async () => {
  await fetchRuns();
  if (runList.value[0]) await selectRun(runList.value[0].runId);
  pollInterval = setInterval(async () => {
    await fetchRuns();
    if (selectedRunId.value) await fetchSelectedRunDetail();
  }, 2000);
});

onUnmounted(() => {
  if (pollInterval !== null) clearInterval(pollInterval);
});

const statusColors: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-600",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-500",
  skipped: "bg-yellow-50 text-yellow-600",
};

function statusClass(status: string): string {
  return statusColors[status] ?? "bg-neutral-100 text-neutral-600";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function nodeEntries(nodes: Record<string, WorkflowNodeState>): [string, WorkflowNodeState][] {
  return Object.entries(nodes);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty list)";
    return value.map((v) => formatValue(v)).join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "(empty)";
    return entries.map(([k, v]) => `${k}: ${formatValue(v)}`).join(" · ");
  }
  return String(value);
}

function outputEntries(outputs: Record<string, unknown>): [string, string][] {
  return Object.entries(outputs).map(([k, v]) => [k, formatValue(v)]);
}

const outputDocumentId = computed<string | null>(() => {
  const out = selectedRunDetail.value?.output;
  if (!out) return null;
  const id = out["documentId"];
  return typeof id === "string" ? id : null;
});

async function downloadOutputDocument() {
  if (!outputDocumentId.value) return;
  const doc = await api.document.get(props.spaceId, outputDocumentId.value);
  window.open(`/${props.spaceSlug}/doc/${doc.slug}.md`, "_blank");
}
</script>

<template>
  <div class="px-xs lg:px-xl py-xl space-y-6 max-w-(--document-width) mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span
          v-if="selectedRunDetail"
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium"
          :class="statusClass(selectedRunDetail.status)"
        >
          <svg
            v-if="selectedRunDetail.status === 'running' || selectedRunDetail.status === 'pending'"
            class="w-3 h-3 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span class="capitalize">{{ selectedRunDetail.status }}</span>
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          v-if="outputDocumentId"
          class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-neutral-300 text-neutral-700 hover:bg-neutral-50 transition-colors"
          @click="downloadOutputDocument"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download
        </button>

        <button
          class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          :disabled="starting || isActiveRun"
          @click="startRun"
        >
        <svg v-if="starting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <svg v-else class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
        </svg>
        {{ starting ? "Starting…" : isActiveRun ? "Running…" : "Run Workflow" }}
        </button>
      </div>
    </div>

    <!-- Run detail -->
    <div v-if="selectedRunDetail" class="space-y-3">
      <!-- Overall output -->
      <div v-if="selectedRunDetail.output && selectedRunDetail.status === 'completed'" class="rounded-lg border border-green-200 bg-green-50 p-4">
        <div class="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">Result</div>
        <dl class="space-y-1">
          <div v-for="[key, val] in outputEntries(selectedRunDetail.output)" :key="key" class="flex gap-2 text-sm">
            <dt class="text-green-700 font-medium shrink-0">{{ key }}</dt>
            <dd class="text-green-900">{{ val }}</dd>
          </div>
        </dl>
      </div>

      <!-- Nodes -->
      <div class="space-y-2">
        <div
          v-for="[nodeId, node] in nodeEntries(selectedRunDetail.nodes)"
          :key="nodeId"
          class="rounded-lg border border-neutral-200 bg-white overflow-hidden"
        >
          <div class="flex items-center justify-between px-4 py-3 gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <!-- Status icon -->
              <span class="flex-shrink-0">
                <svg v-if="node.status === 'running'" class="w-4 h-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                <svg v-else-if="node.status === 'completed'" class="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                </svg>
                <svg v-else-if="node.status === 'failed'" class="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" />
                </svg>
                <svg v-else-if="node.status === 'skipped'" class="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347c-.75.412-1.667-.13-1.667-.986V5.653z" />
                  <path d="M15.75 5.653c0-.856.917-1.398 1.667-.986l.25.138V14.2l-.25.137c-.75.413-1.667-.13-1.667-.986V5.653z" />
                </svg>
                <span v-else class="w-4 h-4 rounded-full border-2 border-neutral-300 block" />
              </span>
              <span class="font-mono text-sm font-medium text-neutral-800 truncate">{{ nodeId }}</span>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0 text-xs text-neutral-400">
              <span v-if="node.startedAt">
                {{ formatDuration(node.startedAt, node.completedAt) }}
              </span>
              <span
                class="px-2 py-0.5 rounded-full font-medium capitalize"
                :class="statusClass(node.status)"
              >{{ node.status }}</span>
            </div>
          </div>

          <!-- Error -->
          <div v-if="node.error" class="border-t border-red-100 bg-red-50 px-4 py-3">
            <div class="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">Error</div>
            <p class="text-sm text-red-800">{{ node.error }}</p>
          </div>

          <!-- Outputs -->
          <div v-if="node.outputs && Object.keys(node.outputs).length > 0" class="border-t border-neutral-100 bg-neutral-50 px-4 py-3">
            <dl class="space-y-1">
              <div v-for="[key, val] in outputEntries(node.outputs)" :key="key" class="flex gap-2 text-sm">
                <dt class="text-neutral-500 font-medium shrink-0">{{ key }}</dt>
                <dd class="text-neutral-800">{{ val }}</dd>
              </div>
            </dl>
          </div>

          <!-- Logs -->
          <div v-if="node.logs && node.logs.length > 0" class="border-t border-neutral-100 px-4 py-3">
            <div class="space-y-0.5 text-xs text-neutral-500">
              <div v-for="(line, i) in node.logs" :key="i">{{ line }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-sm text-neutral-400 py-8 text-center">
      No runs yet. Click "Run Workflow" to execute.
    </div>

    <!-- Run history -->
    <div v-if="runList.length > 0">
      <div class="text-xs font-semibold text-neutral-400 uppercase tracking-wide mb-2">Run history</div>
      <div class="space-y-1">
        <button
          v-for="run in runList"
          :key="run.runId"
          class="w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover:bg-neutral-50 transition-colors"
          :class="run.runId === selectedRunId ? 'bg-neutral-100' : ''"
          @click="selectRun(run.runId)"
        >
          <span class="text-neutral-500 text-xs font-mono">{{ formatDate(run.createdAt) }}</span>
          <span
            class="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
            :class="statusClass(run.status)"
          >{{ run.status }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
