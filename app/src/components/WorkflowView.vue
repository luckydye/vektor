<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
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

type WorkflowNodeDef = { jobId: string; extensionId: string };

const runList = ref<RunSummary[]>([]);
const selectedRunId = ref<string | null>(null);
const selectedRunDetail = ref<WorkflowRunStatus | null>(null);
const workflowDef = ref<Record<string, WorkflowNodeDef>>({});
const starting = ref(false);
const cancelling = ref(false);
const logsExpanded = ref(false);
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
  logsExpanded.value = false;
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

async function cancelRun() {
  const activeRun = runList.value.find((r) => r.status === "running" || r.status === "pending");
  if (!activeRun || cancelling.value) return;
  cancelling.value = true;
  try {
    await api.workflows.cancelRun(props.spaceId, activeRun.runId);
    await fetchRuns();
    await fetchSelectedRunDetail();
  } finally {
    cancelling.value = false;
  }
}

const isActiveRun = computed(() =>
  runList.value.some((r) => r.status === "running" || r.status === "pending"),
);

onMounted(async () => {
  const doc = await api.document.get(props.spaceId, props.documentId);
  try { workflowDef.value = JSON.parse(doc.content ?? "{}"); } catch {}

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

// Pipeline nodes — order is determined by the API (topological sort)
const pipelineNodes = computed((): [string, WorkflowNodeState][] => {
  if (!selectedRunDetail.value) return [];
  return Object.entries(selectedRunDetail.value.nodes);
});

// Job outputs are stored as { type: "text", value } or { type: "file", url } objects
function unwrapOutputValue(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    const v = val as Record<string, unknown>;
    if (v.type === "text" && typeof v.value === "string") return v.value;
    if (v.type === "file" && typeof v.url === "string") return v.url;
  }
  return null;
}

// Output fields
const outputHtml = computed<string | null>(() =>
  unwrapOutputValue(selectedRunDetail.value?.output?.["html"]),
);

const outputDocumentId = computed<string | null>(() =>
  unwrapOutputValue(selectedRunDetail.value?.output?.["documentId"]),
);

const outputDocumentHref = ref<string | null>(null);
const outputDocumentTitle = ref<string | null>(null);

watch(outputDocumentId, async (id) => {
  if (!id) { outputDocumentHref.value = null; outputDocumentTitle.value = null; return; }
  const doc = await api.document.get(props.spaceId, id);
  outputDocumentHref.value = `/${props.spaceSlug}/doc/${doc.slug}`;
  outputDocumentTitle.value = (doc as any).properties?.title || doc.slug;
});

// Run history expansion — lazy load per run
const expandedHistoryRuns = ref<Set<string>>(new Set());
const historyRunDetails = ref<Map<string, WorkflowRunStatus>>(new Map());
const historyRunDocHrefs = ref<Map<string, string>>(new Map());
const historyRunDocTitles = ref<Map<string, string>>(new Map());

async function toggleHistoryRun(runId: string) {
  if (expandedHistoryRuns.value.has(runId)) {
    expandedHistoryRuns.value = new Set([...expandedHistoryRuns.value].filter((id) => id !== runId));
    return;
  }
  expandedHistoryRuns.value = new Set([...expandedHistoryRuns.value, runId]);
  if (historyRunDetails.value.has(runId)) return;
  const detail = await api.workflows.getRun(props.spaceId, runId);
  historyRunDetails.value = new Map([...historyRunDetails.value, [runId, detail]]);
  const docId = unwrapOutputValue(detail.output?.["documentId"]);
  if (docId) {
    const doc = await api.document.get(props.spaceId, docId);
    historyRunDocHrefs.value = new Map([...historyRunDocHrefs.value, [runId, `/${props.spaceSlug}/doc/${doc.slug}`]]);
    historyRunDocTitles.value = new Map([...historyRunDocTitles.value, [runId, (doc as any).properties?.title || doc.slug]]);
  }
}

function historyOutputHtml(runId: string): string | null {
  return unwrapOutputValue(historyRunDetails.value.get(runId)?.output?.["html"]);
}

function historyOutputDocumentHref(runId: string): string | null {
  return historyRunDocHrefs.value.get(runId) ?? null;
}

function historyOutputDocumentTitle(runId: string): string | null {
  return historyRunDocTitles.value.get(runId) ?? null;
}

// All node logs for the expand section
const allLogs = computed(() => {
  if (!selectedRunDetail.value) return [];
  return Object.entries(selectedRunDetail.value.nodes)
    .flatMap(([nodeId, node]) => [
      ...(node.logs ?? []).map((line) => ({ nodeId, line, isError: false })),
      ...(node.error ? [{ nodeId, line: node.error, isError: true }] : []),
    ]);
});


function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const statusBadgeClass: Record<string, string> = {
  pending:   "bg-neutral-100 text-neutral-500",
  running:   "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed:    "bg-red-100 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-400",
};
</script>

<template>
  <div class="px-xs lg:px-xl space-y-8 mx-auto">

    <!-- Header -->
    <div class="flex items-center justify-between gap-4">
      <span
        v-if="selectedRunDetail"
        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium capitalize"
        :class="statusBadgeClass[selectedRunDetail.status] ?? 'bg-neutral-100 text-neutral-500'"
      >
        <svg v-if="selectedRunDetail.status === 'running' || selectedRunDetail.status === 'pending'" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        {{ selectedRunDetail.status }}
      </span>

      <div class="flex items-center gap-2 ml-auto">
        <button
          v-if="isActiveRun"
          class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="cancelling"
          @click="cancelRun"
        >
          <svg v-if="cancelling" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          {{ cancelling ? "Cancelling…" : "Cancel" }}
        </button>
        <button
          v-else
          class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="starting"
          @click="startRun"
        >
          <svg v-if="starting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
          </svg>
          {{ starting ? "Starting…" : "Run Workflow" }}
        </button>
      </div>
    </div>

    <!-- Pipeline progress -->
    <div v-if="pipelineNodes.length > 0" class="py-2 px-6">
      <!-- Track row: circles + lines only -->
      <div class="flex items-center">
        <template v-for="([nodeId, node], i) in pipelineNodes" :key="nodeId">
          <div v-if="i > 0" class="h-px flex-1 min-w-6 transition-colors duration-500" :class="pipelineNodes[i-1][1].status === 'completed' ? 'bg-emerald-300' : 'bg-neutral-200'" />
          <div
            class="w-9 h-9 flex-shrink-0 rounded-full flex items-center justify-center transition-all duration-300 ring-4"
            :class="{
              'bg-neutral-100 ring-neutral-100 text-neutral-400': node.status === 'pending',
              'bg-blue-500 ring-blue-100 text-white': node.status === 'running',
              'bg-emerald-500 ring-emerald-100 text-white': node.status === 'completed',
              'bg-red-500 ring-red-100 text-white': node.status === 'failed',
              'bg-neutral-200 ring-neutral-100 text-neutral-400': node.status === 'cancelled' || node.status === 'skipped',
            }"
          >
            <svg v-if="node.status === 'running'" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
              <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <svg v-else-if="node.status === 'completed'" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <svg v-else-if="node.status === 'failed'" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span v-else class="w-2 h-2 rounded-full bg-current opacity-40" />
          </div>
        </template>
      </div>
      <!-- Labels row: mirrors the track structure -->
      <div class="flex mt-2">
        <template v-for="([nodeId, node], i) in pipelineNodes" :key="nodeId">
          <div v-if="i > 0" class="flex-1 min-w-6" />
          <div class="w-9 flex-shrink-0 flex flex-col items-center">
            <span class="text-[10px] text-neutral-400 leading-tight text-center whitespace-pre">
              <span class="block">Step {{ i + 1 }}</span>
              <span v-if="workflowDef[nodeId]?.jobId" class="block text-neutral-400">{{ workflowDef[nodeId].jobId }}</span>
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- No runs yet -->
    <div v-else-if="!selectedRunDetail" class="text-sm text-neutral-400 py-8 text-center">
      No runs yet. Click "Run Workflow" to execute.
    </div>

    <!-- Results -->
    <div v-if="selectedRunDetail?.status === 'completed'" class="space-y-4">

      <!-- HTML output -->
      <div v-if="outputHtml" class="rounded-xl border border-neutral-200 overflow-hidden">
        <div v-html="outputHtml" class="p-6" />
      </div>

      <!-- Document link -->
      <a
        v-if="outputDocumentId && outputDocumentHref"
        :href="outputDocumentHref"
        class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white hover:border-sky-300 hover:bg-sky-50 transition-colors text-sm font-medium text-neutral-800"
      >
        <svg class="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        {{ outputDocumentTitle ?? "Open document" }}
      </a>

    </div>

    <!-- Logs (expandable) -->
    <div v-if="selectedRunDetail && allLogs.length > 0">
      <button
        class="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 transition-colors"
        @click="logsExpanded = !logsExpanded"
      >
        <svg class="w-3 h-3 transition-transform" :class="logsExpanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        Logs
      </button>
      <div v-if="logsExpanded" class="mt-2 rounded-lg bg-neutral-950 p-4 overflow-x-auto">
        <div class="font-mono text-[11px] space-y-0.5">
          <div v-for="(entry, i) in allLogs" :key="i" class="flex gap-3">
            <span class="text-neutral-500 shrink-0">{{ entry.nodeId }}</span>
            <span :class="entry.isError ? 'text-red-400' : 'text-neutral-300'">{{ entry.line }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Run history -->
    <div v-if="runList.length > 0">
      <div class="text-xs font-semibold text-neutral-400 uppercase tracking-wide mb-2">Run history</div>
      <div class="space-y-1">
        <div
          v-for="run in runList"
          :key="run.runId"
          class="rounded-md border border-transparent transition-colors"
          :class="expandedHistoryRuns.has(run.runId) ? 'border-neutral-200 bg-neutral-50' : ''"
        >
          <div class="flex items-center justify-between px-3 py-2 text-sm">
            <button class="flex items-center gap-2 text-left" @click="selectRun(run.runId)">
              <span class="text-neutral-500 text-xs">{{ formatDate(run.createdAt) }}</span>
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                :class="statusBadgeClass[run.status] ?? 'bg-neutral-100 text-neutral-500'"
              >{{ run.status }}</span>
            </button>
            <button
              v-if="run.status === 'completed'"
              class="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-600 transition-colors ml-2"
              @click="toggleHistoryRun(run.runId)"
            >
              <svg class="w-3 h-3 transition-transform" :class="expandedHistoryRuns.has(run.runId) ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
              Results
            </button>
          </div>

          <!-- Expanded output -->
          <div v-if="expandedHistoryRuns.has(run.runId)" class="px-3 pb-3 space-y-3">
            <template v-if="historyRunDetails.has(run.runId)">
              <div v-if="historyOutputHtml(run.runId)" class="rounded-lg border border-neutral-200 overflow-hidden bg-white">
                <div v-html="historyOutputHtml(run.runId)" class="p-4" />
              </div>
              <a
                v-if="historyOutputDocumentHref(run.runId)"
                :href="historyOutputDocumentHref(run.runId)!"
                class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 bg-white hover:border-sky-300 hover:bg-sky-50 transition-colors text-sm font-medium text-neutral-800"
              >
                <svg class="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                {{ historyOutputDocumentTitle(run.runId) ?? "Open document" }}
              </a>
              <p v-if="!historyOutputHtml(run.runId) && !historyOutputDocumentHref(run.runId)" class="text-xs text-neutral-400">No output</p>
            </template>
            <div v-else class="text-xs text-neutral-400">Loading…</div>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>
