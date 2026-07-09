<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { WorkflowNodeState, WorkflowRunStatus } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { usePagedList } from "#composeables/usePagedList.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { replaceBrowserUrl } from "#utils/browserHistory.ts";
import { propertyValueToText } from "#utils/documentProperties.ts";
import { downloadExcelRows, parseCsvRows } from "#utils/excelExport.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import { spacePath } from "#utils/utils.ts";
import {
  arrowDownTrayIcon,
  checkBoldIcon,
  chevronLeftThinIcon,
  chevronRightSmallIcon,
  clipboardDocumentIcon,
  closeXIcon,
  spinnerQuarterIcon,
} from "~/src/assets/icons.ts";
import "@atrium-ui/elements/tabs";
import DataTable from "./DataTable.vue";
import Pager from "./Pager.vue";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const { currentSpace } = useSpace();

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
  goToPage: runGoToPage,
  refresh: refreshRuns,
} = usePagedList<RunSummary>({
  queryKey: computed(() => ["workflow_runs", props.spaceId, props.documentId]),
  fetcher: ({ limit, offset }) =>
    api.workflows
      .listRuns(props.spaceId, { filterDocumentId: props.documentId, limit, offset })
      .then((r) => ({ items: r.runs, total: r.total })),
  pageSize: 20,
});

function runIdFromUrl(): string | null {
  const runParam = new URLSearchParams(window.location.search).get("run")?.trim();
  if (runParam) return runParam;

  const hash = window.location.hash.slice(1).trim();
  if (!hash) return null;
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function setRunSearchParam(runId: string) {
  if (runIdFromUrl() === runId) return;
  const url = new URL(window.location.href);
  url.searchParams.set("run", runId);
  url.hash = "";
  replaceBrowserUrl(url);
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

async function selectRun(runId: string, options: { updateUrl?: boolean } = {}) {
  if (options.updateUrl ?? true) setRunSearchParam(runId);
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

async function downloadFile(url: string, fileName: string, exportFileName = fileName) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (fileName.toLowerCase().endsWith(".csv") || contentType.includes("text/csv")) {
    downloadExcelRows(parseCsvRows(await response.text()), exportFileName);
    return;
  }
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
    const urlRunId = runIdFromUrl();
    if (!selectedRunId.value) {
      await selectRun(urlRunId ?? newRuns[0].runId, { updateUrl: false });
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
    sourceExtensionHref.value = firstRoute ? `/x/${firstRoute.path}` : null;
  },
  { immediate: true },
);

function handleUrlChange() {
  const runId = runIdFromUrl();
  if (runId && runId !== selectedRunId.value) {
    void selectRun(runId, { updateUrl: false });
  } else if (
    !runId &&
    runList.value[0] &&
    runList.value[0].runId !== selectedRunId.value
  ) {
    void selectRun(runList.value[0].runId, { updateUrl: false });
  }
}

onMounted(() => {
  const urlRunId = runIdFromUrl();
  if (urlRunId && selectedRunId.value !== urlRunId)
    void selectRun(urlRunId, { updateUrl: false });
  window.addEventListener("popstate", handleUrlChange);
  window.addEventListener("hashchange", handleUrlChange);

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
  window.removeEventListener("popstate", handleUrlChange);
  window.removeEventListener("hashchange", handleUrlChange);
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
  outputDocumentHref.value = spacePath(currentSpace.value?.slug, `/doc/${doc.slug}`);
  outputDocumentTitle.value = doc.properties?.title
    ? propertyValueToText(doc.properties.title)
    : doc.slug;
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
      [runId, spacePath(currentSpace.value?.slug, `/doc/${doc.slug}`)],
    ]);
    historyRunDocTitles.value = new Map([
      ...historyRunDocTitles.value,
      [
        runId,
        doc.properties?.title ? propertyValueToText(doc.properties.title) : doc.slug,
      ],
    ]);
  }
}

function historyOutputHtml(runId: string): string | null {
  return unwrapOutputValue(historyRunDetails.value.get(runId)?.output?.html);
}

function historyOutputData(runId: string): Record<string, unknown>[] | null {
  return extractTableData(historyRunDetails.value.get(runId)?.output);
}

function historyRunTitle(run: RunSummary): string | null {
  const title =
    run.runtimeInputs?.title ??
    historyRunDetails.value.get(run.runId)?.runtimeInputs?.title;
  return typeof title === "string" ? title : null;
}

function historyOutputDocumentHref(runId: string): string | null {
  return historyRunDocHrefs.value.get(runId) ?? null;
}

function historyOutputDocumentTitle(runId: string): string | null {
  return historyRunDocTitles.value.get(runId) ?? null;
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
    <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
    <a
      :href="sourceExtensionHref"
      class="inline-flex items-center gap-1.5 text-size-medium text-neutral-400 hover:text-neutral-600 transition-colors"
    >
      <div class="svg-icon w-4 h-4" v-html="chevronLeftThinIcon" />
      Back
    </a>
  </Teleport>

  <div class="px-xs lg:px-xl space-y-8 mx-auto mb-12">

    <div class="flex justify-between gap-4">
        <!-- Title -->
        <h2 class="text-size-title font-semibold text-neutral-800">{{ selectedRunTitle || "Untitled" }}</h2>
    
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

    <!-- Tabs: Results / Run Details / History -->
    <a-tabs>
      <a-tabs-list class="border-b border-neutral-100">
        <a-tabs-tab class="px-4 py-2.5 text-size-medium text-neutral-500 border-b-2 border-transparent [&[selected]]:text-neutral-900 [&[selected]]:border-neutral-900">Results</a-tabs-tab>
        <a-tabs-tab class="px-4 py-2.5 text-size-medium text-neutral-500 border-b-2 border-transparent [&[selected]]:text-neutral-900 [&[selected]]:border-neutral-900">Run Details</a-tabs-tab>
        <a-tabs-tab class="px-4 py-2.5 text-size-medium text-neutral-500 border-b-2 border-transparent [&[selected]]:text-neutral-900 [&[selected]]:border-neutral-900">History</a-tabs-tab>
      </a-tabs-list>

      <!-- Results panel -->
      <a-tabs-panel>
        <div class="space-y-4 pt-4">
          <template v-if="selectedRunDetail?.status === 'completed'">
            <!-- HTML output -->
            <div v-if="outputHtml" class="rounded-xl border border-neutral-200 overflow-hidden">
              <div v-html="outputHtml" class="p-2" />
            </div>

            <!-- Data table -->
            <DataTable
              v-if="outputData"
              :data="outputData"
              :document-id="props.documentId"
              :export-file-name="selectedRunTitle ?? 'data'"
            />

            <div class="flex flex-wrap items-center gap-2">
              <!-- Document link -->
              <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
              <a
                v-if="outputDocumentId && outputDocumentHref"
                :href="outputDocumentHref"
                class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
              >
                <div class="svg-icon w-4 h-4 text-neutral-400" v-html="clipboardDocumentIcon" />
                {{ outputDocumentTitle ?? "Open document" }}
              </a>

              <!-- File download -->
              <template v-if="selectedRunFileUrl && selectedRunFileName">
                <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
                <a
                  :href="selectedRunFileUrl"
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
                >
                  <div class="svg-icon w-4 h-4 text-neutral-400" v-html="clipboardDocumentIcon" />
                  {{ selectedRunFileName }}
                </a>
                <button type="button"
                  class="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-size-medium text-neutral-500"
                  title="Download"
                  @click="downloadFile(selectedRunFileUrl!, selectedRunFileName!, selectedRunTitle ?? selectedRunFileName!)"
                >
                  <div class="svg-icon w-4 h-4" v-html="arrowDownTrayIcon" />
                </button>
              </template>
            </div>

            <p
              v-if="!outputHtml && !outputData && !outputDocumentId && !selectedRunFileUrl"
              class="text-size-medium text-neutral-400"
            >No output</p>
          </template>

          <p v-else class="text-size-medium text-neutral-400">
            {{ !selectedRunDetail ? (selectedRunError ?? 'Select a run from History to see results.') : selectedRunDetail.status === 'failed' ? 'Run failed.' : 'Run did not complete.' }}
          </p>
        </div>
      </a-tabs-panel>

      <!-- Run Details panel -->
      <a-tabs-panel>
        <div class="space-y-6 pt-4">
          <!-- Input fields -->
          <div v-if="selectedRunInputs">
            <div class="mb-2 text-size-small font-medium text-neutral-500 uppercase tracking-wide">Input fields</div>
            <div class="rounded-lg border border-neutral-100 overflow-hidden">
              <div class="grid grid-cols-[180px_1fr] items-center h-9 border-b border-neutral-100 bg-neutral-50">
                <div class="px-4 text-size-small font-medium text-neutral-500 uppercase tracking-wide">Field</div>
                <div class="pr-4 text-size-small font-medium text-neutral-500 uppercase tracking-wide">Value</div>
              </div>
              <div>
                <div
                  v-for="(val, key) in selectedRunInputs"
                  :key="key"
                  class="grid grid-cols-[180px_1fr] border-b border-neutral-100 last:border-b-0 transition-colors hover:bg-neutral-50"
                >
                  <div class="px-4 py-2.5 font-mono text-[11px] font-medium text-neutral-500 truncate">{{ key }}</div>
                  <pre class="px-0 py-2.5 pr-4 overflow-x-auto whitespace-pre-wrap break-all text-size-small text-neutral-700">{{ typeof val === 'object' ? JSON.stringify(val, null, 2) : val }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- Logs -->
          <div v-if="allLogs.length > 0" class="flex flex-col p-4 bg-neutral-950 dark:bg-neutral-50 rounded-lg">
            <button type="button"
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

          <p v-if="!selectedRunInputs && allLogs.length === 0" class="text-size-medium text-neutral-400">No details available.</p>
        </div>
      </a-tabs-panel>

      <!-- History panel -->
      <a-tabs-panel>
        <div class="pt-2">
          <div v-if="runList.length > 0 || runTotalPages > 1">
            <div
              class="grid grid-cols-[1fr_120px_140px] items-center h-9 border-b border-neutral-100 bg-neutral-50 sticky top-0 z-10 transition-colors"
            >
              <div class="px-4 text-size-small font-medium text-neutral-500 uppercase tracking-wide">
                Run
              </div>
              <div class="text-size-small font-medium text-neutral-500 uppercase tracking-wide">
                Status
              </div>
              <div class="pr-4 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">
                Results
              </div>
            </div>
            <div>
              <div
                v-for="run in runList"
                :key="run.runId"
                class="border-b border-neutral-100 group transition-colors hover:transition-none"
                :class="selectedRunId === run.runId ? 'bg-primary-50' : 'hover:bg-neutral-50'"
              >
                <div class="grid grid-cols-[1fr_120px_140px] items-center text-size-medium">
                  <button type="button"
                    class="flex items-center gap-2 min-w-0 py-2.5 px-4 text-left"
                    @click="selectRun(run.runId)"
                  >
                    <span class="text-size-medium font-medium text-neutral-800 truncate">
                      {{ historyRunTitle(run) || "Untitled" }}
                    </span>
                    <span class="text-neutral-400 text-size-small tabular-nums shrink-0">
                      {{ formatDate(run.createdAt) }}
                    </span>
                  </button>

                  <div class="flex items-center py-2.5 pr-3">
                    <span
                      class="px-1.5 py-0.5 rounded-sm text-[11px] font-medium capitalize"
                      :class="statusBadgeClass[run.status] ?? 'bg-neutral-100 text-neutral-500'"
                    >{{ run.status }}</span>
                  </div>

                  <div class="flex items-center justify-end py-2.5 pr-4">
                    <button type="button"
                      v-if="run.status === 'completed'"
                      class="inline-flex items-center gap-1 text-size-small text-neutral-400 hover:text-neutral-600 transition-colors"
                      @click="toggleHistoryRun(run.runId)"
                    >
                      <div class="svg-icon w-3 h-3 transition-transform" :class="expandedHistoryRuns.has(run.runId) ? 'rotate-90' : ''" v-html="chevronRightSmallIcon" />
                      Results
                    </button>
                    <span v-else class="text-size-small text-neutral-300">-</span>
                  </div>
                </div>

                <!-- Expanded output -->
                <div
                  v-if="expandedHistoryRuns.has(run.runId)"
                  class="px-4 pb-4 space-y-3 bg-neutral-50"
                >
                  <template v-if="historyRunDetails.has(run.runId)">
                    <div v-if="historyOutputHtml(run.runId)" class="rounded-lg border border-neutral-200 overflow-hidden bg-white dark:bg-neutral-100">
                      <div v-html="historyOutputHtml(run.runId)" class="p-4" />
                    </div>
                    <DataTable
                      v-if="historyOutputData(run.runId)"
                      :data="historyOutputData(run.runId)!"
                      :document-id="props.documentId"
                      :export-file-name="historyRunTitle(run) ?? 'data'"
                    />
                    <div v-if="historyOutputDocumentHref(run.runId)" class="inline-flex items-center gap-2">
                      <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
                      <a
                        :href="historyOutputDocumentHref(run.runId)!"
                        class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
                      >
                        <div class="svg-icon w-4 h-4 text-neutral-400" v-html="clipboardDocumentIcon" />
                        {{ historyOutputDocumentTitle(run.runId) ?? "Open document" }}
                      </a>
                    </div>
                    <p v-if="!historyOutputHtml(run.runId) && !historyOutputDocumentHref(run.runId) && !historyOutputData(run.runId)" class="text-size-small text-neutral-400">No output</p>
                  </template>
                  <div v-else class="text-size-small text-neutral-400">Loading…</div>
                </div>
              </div>
            </div>

            <Pager
              class="mt-4 pt-3 mb-12"
              :page="runPage"
              :total-pages="runTotalPages"
              @change="runGoToPage"
            />
          </div>
          <p v-else class="text-size-medium text-neutral-400 py-8 text-center">No runs yet.</p>
        </div>
      </a-tabs-panel>
    </a-tabs>

  </div>
</template>
