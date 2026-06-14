<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  arrowDownTrayIcon,
  checkBoldIcon,
  chevronLeftThinIcon,
  chevronRightSmallIcon,
  clipboardDocumentIcon,
  closeXIcon,
  spinnerQuarterIcon,
} from "~/src/assets/icons.ts";
import type { WorkflowNodeState, WorkflowRunStatus } from "../api/ApiClient.ts";
import { api } from "../api/client.ts";
import { usePagedList } from "../composeables/usePagedList.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import DataTable from "./DataTable.vue";

const props = defineProps<{
  documentId: string;
  spaceId: string;
  spaceSlug: string;
}>();

type RunSummary = {
  runId: string;
  status: string;
  createdAt: string;
  sourceExtensionId: string | null;
  runtimeInputs: Record<string, unknown>;
};

const sourceExtensionHref = ref<string | null>(null);
const selectedRunId = ref<string | null>(null);
const selectedRunDetail = ref<WorkflowRunStatus | null>(null);
const selectedRunError = ref<string | null>(null);
const logsExpanded = ref(false);
let unsubscribeRuns: (() => void) | null = null;
let unsubscribeRun: (() => void) | null = null;

const {
  items: runList,
  page: runPage,
  totalPages: runTotalPages,
  hasPrevPage: runHasPrevPage,
  hasNextPage: runHasNextPage,
  prevPage: runPrevPage,
  nextPage: runNextPage,
  refresh: refreshRuns,
} = usePagedList<RunSummary>({
  queryKey: computed(() => ["workflow_runs", props.spaceId, props.documentId]),
  fetcher: ({ limit, offset }) =>
    api.workflows
      .listRuns(props.spaceId, { filterDocumentId: props.documentId, limit, offset })
      .then((r) => ({ items: r.runs, total: r.total })),
  pageSize: 20,
});

function runIdFromHash(): string | null {
  const hash = window.location.hash.slice(1).trim();
  if (!hash) return null;
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function setRunHash(runId: string) {
  if (runIdFromHash() === runId) return;
  window.location.hash = encodeURIComponent(runId);
}

// Follow the selected run with a per-run realtime subscription.
watch(selectedRunId, (runId) => {
  unsubscribeRun?.();
  unsubscribeRun = null;
  if (runId) {
    unsubscribeRun = api.subscribeToTopics(
      props.spaceId,
      [realtimeTopics.workflowRun(runId)],
      () => {
        void fetchSelectedRunDetail();
      },
    );
  }
});

async function fetchSelectedRunDetail() {
  if (!selectedRunId.value) return;
  const runId = selectedRunId.value;
  try {
    const detail = await api.workflows.getRun(props.spaceId, runId);
    if (selectedRunId.value !== runId) return;
    if (detail.documentId && detail.documentId !== props.documentId) {
      throw new Error("Workflow run not found for this document");
    }
    selectedRunDetail.value = detail;
    selectedRunError.value = null;
  } catch (err) {
    if (selectedRunId.value !== runId) return;
    selectedRunDetail.value = null;
    selectedRunError.value =
      err instanceof Error ? err.message : "Failed to load workflow run";
  }
}

async function selectRun(runId: string, options: { updateHash?: boolean } = {}) {
  if (options.updateHash ?? true) setRunHash(runId);
  selectedRunId.value = runId;
  logsExpanded.value = false;
  await fetchSelectedRunDetail();
}

const selectedRun = computed(() =>
  runList.value.find((r) => r.runId === selectedRunId.value),
);

const selectedRunSourceExtensionId = computed(
  () =>
    selectedRun.value?.sourceExtensionId ??
    selectedRunDetail.value?.sourceExtensionId ??
    null,
);

const selectedRunCreatedAt = computed(
  () => selectedRun.value?.createdAt ?? selectedRunDetail.value?.createdAt ?? null,
);

const selectedRunTitle = computed(() => {
  const title =
    selectedRun.value?.runtimeInputs?.title ??
    selectedRunDetail.value?.runtimeInputs?.title;
  return typeof title === "string" ? title : null;
});

const selectedRunFileName = computed(() => {
  const name =
    selectedRun.value?.runtimeInputs?.fileName ??
    selectedRunDetail.value?.runtimeInputs?.fileName;
  return typeof name === "string" ? name : null;
});

const selectedRunFileUrl = computed(() => {
  const file =
    selectedRun.value?.runtimeInputs?.file ??
    selectedRunDetail.value?.runtimeInputs?.file;
  return typeof file === "string" ? file : null;
});

async function downloadFile(url: string, fileName: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const blob = await response.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

const selectedRunInputs = computed(() => {
  const inputs =
    selectedRun.value?.runtimeInputs ?? selectedRunDetail.value?.runtimeInputs;
  if (!inputs || Object.keys(inputs).length === 0) return null;
  return inputs;
});

// Auto-select the first run and load extension info once on initial data arrival.
// Uses `immediate: true` so cached data (served synchronously on client navigation)
// triggers the callback even when runList doesn't change after the watcher is registered.
// The per-field guards keep the side-effects idempotent across subsequent list updates.
watch(
  runList,
  async (newRuns) => {
    if (newRuns.length === 0) return;
    const hashedRunId = runIdFromHash();
    if (!selectedRunId.value) {
      await selectRun(hashedRunId ?? newRuns[0].runId, { updateHash: false });
    }
  },
  { immediate: true },
);

watch(
  selectedRunSourceExtensionId,
  async (sourceExtId) => {
    if (!sourceExtId) {
      sourceExtensionHref.value = null;
      return;
    }
    const ext = await api.extensions.getById(props.spaceId, sourceExtId);
    if (selectedRunSourceExtensionId.value !== sourceExtId) return;
    const firstRoute = ext.routes?.[0];
    sourceExtensionHref.value = firstRoute
      ? `/${props.spaceSlug}/x/${firstRoute.path}`
      : null;
  },
  { immediate: true },
);

function handleHashChange() {
  const runId = runIdFromHash();
  if (runId && runId !== selectedRunId.value) {
    void selectRun(runId, { updateHash: false });
  } else if (
    !runId &&
    runList.value[0] &&
    runList.value[0].runId !== selectedRunId.value
  ) {
    void selectRun(runList.value[0].runId, { updateHash: false });
  }
}

onMounted(() => {
  const hashedRunId = runIdFromHash();
  if (hashedRunId && selectedRunId.value !== hashedRunId)
    void selectRun(hashedRunId, { updateHash: false });
  window.addEventListener("hashchange", handleHashChange);

  // Any run change in the space refreshes the list (and the open run detail).
  // When a run is started elsewhere (e.g. the header button) and nothing is
  // selected yet, follow the newest run so it shows up immediately.
  unsubscribeRuns = api.subscribeToTopics(
    props.spaceId,
    [realtimeTopics.workflowRuns],
    async () => {
      refreshRuns();
      if (selectedRunId.value) await fetchSelectedRunDetail();
    },
  );
});

onUnmounted(() => {
  window.removeEventListener("hashchange", handleHashChange);
  unsubscribeRuns?.();
  unsubscribeRun?.();
});

// Pipeline nodes — insertion order = execution order for JS scripts; _script is the wrapper
const pipelineNodes = computed((): [string, WorkflowNodeState][] => {
  if (!selectedRunDetail.value) return [];
  return Object.entries(selectedRunDetail.value.nodes).filter(([id]) => id !== "_script");
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
  unwrapOutputValue(selectedRunDetail.value?.output?.html),
);

const outputDocumentId = computed<string | null>(() =>
  unwrapOutputValue(selectedRunDetail.value?.output?.documentId),
);

function extractTableData(
  output: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] | null {
  let raw: unknown = output?.data ?? output?.result;
  // unwrap { type: "text", value: "..." } envelope
  const str = unwrapOutputValue(raw);
  if (str !== null) {
    try {
      raw = JSON.parse(str);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (typeof raw[0] !== "object" || raw[0] === null) return null;
  return raw as Record<string, unknown>[];
}

const outputData = computed(() => extractTableData(selectedRunDetail.value?.output));

const outputDocumentHref = ref<string | null>(null);
const outputDocumentTitle = ref<string | null>(null);

watch(outputDocumentId, async (id) => {
  if (!id) {
    outputDocumentHref.value = null;
    outputDocumentTitle.value = null;
    return;
  }
  const doc = await api.document.get(props.spaceId, id);
  outputDocumentHref.value = `/${props.spaceSlug}/doc/${doc.slug}`;
  outputDocumentTitle.value =
    (doc as { properties?: { title?: string } }).properties?.title || doc.slug;
});

// Run history expansion — lazy load per run
const expandedHistoryRuns = ref<Set<string>>(new Set());
const historyRunDetails = ref<Map<string, WorkflowRunStatus>>(new Map());
const historyRunDocHrefs = ref<Map<string, string>>(new Map());
const historyRunDocTitles = ref<Map<string, string>>(new Map());

async function toggleHistoryRun(runId: string) {
  if (expandedHistoryRuns.value.has(runId)) {
    expandedHistoryRuns.value = new Set(
      [...expandedHistoryRuns.value].filter((id) => id !== runId),
    );
    return;
  }
  expandedHistoryRuns.value = new Set([...expandedHistoryRuns.value, runId]);
  if (historyRunDetails.value.has(runId)) return;
  const detail = await api.workflows.getRun(props.spaceId, runId);
  historyRunDetails.value = new Map([...historyRunDetails.value, [runId, detail]]);
  const docId = unwrapOutputValue(detail.output?.documentId);
  if (docId) {
    const doc = await api.document.get(props.spaceId, docId);
    historyRunDocHrefs.value = new Map([
      ...historyRunDocHrefs.value,
      [runId, `/${props.spaceSlug}/doc/${doc.slug}`],
    ]);
    historyRunDocTitles.value = new Map([
      ...historyRunDocTitles.value,
      [runId, (doc as { properties?: { title?: string } }).properties?.title || doc.slug],
    ]);
  }
}

function historyOutputHtml(runId: string): string | null {
  return unwrapOutputValue(historyRunDetails.value.get(runId)?.output?.html);
}

function historyOutputData(runId: string): Record<string, unknown>[] | null {
  return extractTableData(historyRunDetails.value.get(runId)?.output);
}

function historyOutputDocumentHref(runId: string): string | null {
  return historyRunDocHrefs.value.get(runId) ?? null;
}

function historyOutputDocumentTitle(runId: string): string | null {
  return historyRunDocTitles.value.get(runId) ?? null;
}

async function downloadDocument(href: string, title: string) {
  const response = await fetch(`${href}.md`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

const runFailureError = computed<{ nodeId: string; error: string } | null>(() => {
  if (selectedRunDetail.value?.status !== "failed") return null;
  for (const [nodeId, node] of Object.entries(selectedRunDetail.value.nodes)) {
    if (node.status === "failed" && node.error) return { nodeId, error: node.error };
  }
  return null;
});

// All node logs for the expand section
const allLogs = computed(() => {
  if (!selectedRunDetail.value) return [];
  return Object.entries(selectedRunDetail.value.nodes).flatMap(([nodeId, node]) => [
    ...(node.logs ?? []).map((line) => ({ nodeId, line, isError: false })),
    ...(node.error ? [{ nodeId, line: node.error, isError: true }] : []),
  ]);
});

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const statusBadgeClass: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-500",
  running: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400",
  completed:
    "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400",
  failed: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
  cancelled: "bg-neutral-100 text-neutral-400",
};
</script>

<template>
  <Teleport v-if="sourceExtensionHref" to="#workflow-breadcrumb-slot">
    <a
      :href="sourceExtensionHref"
      class="inline-flex items-center gap-1.5 text-size-medium text-neutral-400 hover:text-neutral-600 transition-colors"
    >
      <div class="svg-icon w-4 h-4" v-html="chevronLeftThinIcon" />
      Back
    </a>
  </Teleport>

  <div class="px-xs lg:px-xl space-y-8 mx-auto">

    <div class="flex justify-between gap-4">
        <!-- Title -->
        <h2 class="text-size-title-2 font-semibold text-neutral-800 dark:text-neutral-200">{{ selectedRunTitle || "Untitled" }}</h2>
    
        <!-- Header -->
        <div class="flex items-center justify-between gap-12">
            <div class="flex items-center gap-3">
                <span v-if="selectedRunCreatedAt" class="text-size-small text-neutral-400">
                  {{ formatDate(selectedRunCreatedAt) }}
                </span>
                <div v-if="selectedRunDetail" class="flex items-center gap-3">
                    <span
                        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-size-medium font-medium capitalize"
                        :class="statusBadgeClass[selectedRunDetail.status] ?? 'bg-neutral-100 text-neutral-500'"
                        >
                        <div v-if="selectedRunDetail.status === 'running' || selectedRunDetail.status === 'pending'" class="svg-icon w-3 h-3 animate-spin" v-html="spinnerQuarterIcon" />
                        {{ selectedRunDetail.status }}
                    </span>
                </div>
            </div>
    
        </div>
    </div>

    <!-- Pipeline progress -->
    
    <!-- Input fields -->
    <details v-if="selectedRunInputs" class="text-size-small">
      <summary class="cursor-pointer text-neutral-400 hover:text-neutral-600 select-none">Input fields</summary>
      <div class="mt-2 space-y-2">
        <div v-for="(val, key) in selectedRunInputs" :key="key" class="rounded-lg border border-neutral-200 overflow-hidden">
          <div class="px-3 py-1.5 bg-neutral-50 dark:bg-neutral-800 font-mono font-semibold text-neutral-500 border-b border-neutral-200">{{ key }}</div>
          <pre class="px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-neutral-700 dark:text-neutral-300">{{ typeof val === 'object' ? JSON.stringify(val, null, 2) : val }}</pre>
        </div>
      </div>
    </details>
    
    <!-- Logs (expandable) -->
    <div v-if="selectedRunDetail && allLogs.length > 0" class="flex flex-col p-4 bg-neutral-950 dark:bg-neutral-50 rounded-lg">
        <button
            class="flex items-center gap-1.5 text-size-small text-neutral-400 hover:text-neutral-600 transition-colors"
            @click="logsExpanded = !logsExpanded"
        >
        <div class="svg-icon w-3 h-3 transition-transform" :class="logsExpanded ? 'rotate-90' : ''" v-html="chevronRightSmallIcon" />
            Logs
        </button>
        <div v-if="logsExpanded || runFailureError" class="mt-2 w-full overflow-x-auto max-h-[400px]">
            <div class="font-mono text-[11px] space-y-0.5">
                <div v-for="(entry, i) in allLogs" :key="i" class="flex gap-3">
                <span class="text-neutral-500 dark:text-neutral-400 shrink-0">{{ entry.nodeId }}</span>
                <span :class="entry.isError ? 'text-red-400' : 'text-neutral-300 dark:text-neutral-600'">{{ entry.line }}</span>
                </div>
            </div>
        </div>
    </div>
    
    <!-- No runs yet -->
    <div v-if="!selectedRunDetail" class="text-size-medium text-neutral-400 py-8 text-center">
      {{ selectedRunError ?? 'No runs yet. Click "Run Workflow" to execute.' }}
    </div>

    <!-- Results -->
    <div v-if="selectedRunDetail?.status === 'completed'" class="space-y-4">

      <!-- HTML output -->
      <div v-if="outputHtml" class="rounded-xl border border-neutral-200 overflow-hidden">
        <div v-html="outputHtml" class="p-2" />
      </div>

      <!-- Data table -->
      <DataTable v-if="outputData" :data="outputData" :space-slug="props.spaceSlug" :document-id="props.documentId" />

      <!-- Document link -->
      <div v-if="outputDocumentId && outputDocumentHref" class="inline-flex items-center gap-2">
        <a
          :href="outputDocumentHref"
          class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
        >
          <div class="svg-icon w-4 h-4 text-neutral-400" v-html="clipboardDocumentIcon" />
          {{ outputDocumentTitle ?? "Open document" }}
        </a>
        <button
          class="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-size-medium text-neutral-500"
          title="Download as Markdown"
          @click="downloadDocument(outputDocumentHref!, outputDocumentTitle ?? 'document')"
        >
          <div class="svg-icon w-4 h-4" v-html="arrowDownTrayIcon" />
        </button>
      </div>

      <!-- File input -->
      <div v-if="selectedRunFileUrl && selectedRunFileName" class="inline-flex items-center gap-2 ml-4">
        <a
          :href="selectedRunFileUrl"
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
        >
          <div class="svg-icon w-4 h-4 text-neutral-400" v-html="clipboardDocumentIcon" />
          {{ selectedRunFileName }}
        </a>
        <button
          class="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-size-medium text-neutral-500"
          title="Download"
          @click="downloadFile(selectedRunFileUrl!, selectedRunFileName!)"
        >
          <div class="svg-icon w-4 h-4" v-html="arrowDownTrayIcon" />
        </button>
      </div>

    </div>

    <!-- Run history -->
    <div v-if="runList.length > 0 || runTotalPages > 1">
      <div class="text-size-small font-semibold text-neutral-400 uppercase tracking-wide mb-6">Run history</div>
      <div class="space-y-1">
        <div
          v-for="run in runList"
          :key="run.runId"
          class="rounded-md border border-transparent transition-colors"
          :class="expandedHistoryRuns.has(run.runId) ? 'border-neutral-200 bg-neutral-50' : ''"
        >
          <div class="flex items-center justify-between py-2 text-size-medium">
            <button class="flex items-center gap-2 text-left" @click="selectRun(run.runId)">
              <span class="text-neutral-500 text-size-small">{{ formatDate(run.createdAt) }}</span>
              <span
                class="px-2 py-0.5 rounded-full text-size-small font-medium capitalize"
                :class="statusBadgeClass[run.status] ?? 'bg-neutral-100 text-neutral-500'"
              >{{ run.status }}</span>
            </button>
            <button
              v-if="run.status === 'completed'"
              class="flex items-center gap-1 text-size-small text-neutral-400 hover:text-neutral-600 transition-colors ml-2"
              @click="toggleHistoryRun(run.runId)"
            >
              <div class="svg-icon w-3 h-3 transition-transform" :class="expandedHistoryRuns.has(run.runId) ? 'rotate-90' : ''" v-html="chevronRightSmallIcon" />
              Results
            </button>
          </div>

          <!-- Expanded output -->
          <div v-if="expandedHistoryRuns.has(run.runId)" class="px-3 pb-3 space-y-3">
            <template v-if="historyRunDetails.has(run.runId)">
              <div v-if="historyOutputHtml(run.runId)" class="rounded-lg border border-neutral-200 overflow-hidden bg-white dark:bg-neutral-100">
                <div v-html="historyOutputHtml(run.runId)" class="p-4" />
              </div>
              <DataTable v-if="historyOutputData(run.runId)" :data="historyOutputData(run.runId)!" :space-slug="props.spaceSlug" :document-id="props.documentId" />

              <div v-if="historyOutputDocumentHref(run.runId)" class="inline-flex items-center gap-2">
                <a
                  :href="historyOutputDocumentHref(run.runId)!"
                  class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
                >
                  <div class="svg-icon w-4 h-4 text-neutral-400" v-html="clipboardDocumentIcon" />
                  {{ historyOutputDocumentTitle(run.runId) ?? "Open document" }}
                </a>
                <button
                  class="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-size-medium text-neutral-500"
                  title="Download as Markdown"
                  @click="downloadDocument(historyOutputDocumentHref(run.runId)!, historyOutputDocumentTitle(run.runId) ?? 'document')"
                >
                  <div class="svg-icon w-4 h-4" v-html="arrowDownTrayIcon" />
                </button>
              </div>
              <p v-if="!historyOutputHtml(run.runId) && !historyOutputDocumentHref(run.runId) && !historyOutputData(run.runId)" class="text-size-small text-neutral-400">No output</p>
            </template>
            <div v-else class="text-size-small text-neutral-400">Loading…</div>
          </div>
        </div>
      </div>

      <!-- Run history pagination -->
      <div v-if="runTotalPages > 1" class="flex items-center justify-between mt-4 pt-3 border-t border-neutral-100">
        <button
          @click="runPrevPage"
          :disabled="!runHasPrevPage"
          class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Previous
        </button>
        <span class="text-size-small text-neutral-400">{{ runPage }} / {{ runTotalPages }}</span>
        <button
          @click="runNextPage"
          :disabled="!runHasNextPage"
          class="px-2.5 py-1 text-size-small font-medium border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>

  </div>
</template>
