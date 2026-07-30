<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { WorkflowRunStatus } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import {
  chevronLeftThinIcon,
  documentIcon,
  downloadIcon,
  fileAttachmentIcon,
  refreshIcon,
  spinnerIcon,
} from "#assets/icons.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useViewTransitionList } from "#composeables/useViewTransitionList.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { formatDateTime } from "#utils/datetime.ts";
import { spacePath } from "#utils/utils.ts";
import { viewTransitionName } from "#utils/viewTransition.ts";
import { downloadExcelRows, parseCsvRows } from "#utils/xlsx.ts";
import "@atrium-ui/elements/tabs";
import DataTable from "./DataTable.vue";
import WorkflowRunHistory from "./WorkflowRunHistory.vue";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const { currentSpace } = useSpace();
const router = useRouter();

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
const selectedRunResult = ref<Record<string, unknown> | null>(null);
const selectedRunError = ref<string | null>(null);
let unsubscribeRuns: (() => void) | null = null;
let unsubscribeRun: (() => void) | null = null;

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};
const workflowTabsEl = ref<ATabsEl | null>(null);
const selectedWorkflowTabIndex = ref(0);

function animateWorkflowTabPanel(index: number, direction: "next" | "previous") {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  requestAnimationFrame(() => {
    const panel = workflowTabsEl.value?.querySelectorAll("a-tabs-panel").item(index);
    const content = panel?.firstElementChild as HTMLElement | null;
    if (!content) return;

    for (const animation of content.getAnimations()) animation.cancel();

    const easing = getComputedStyle(document.documentElement)
      .getPropertyValue("--emphasized-curve")
      .trim();
    content.animate(
      [
        {
          opacity: 0,
          transform: `translateX(${direction === "next" ? 8 : -8}px)`,
        },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: 180, easing: easing || "ease-out" },
    );
  });
}

function handleWorkflowTabSelected(event: Event) {
  const { index } = (event as CustomEvent<{ index: number }>).detail;
  if (index === selectedWorkflowTabIndex.value) return;

  const direction = index > selectedWorkflowTabIndex.value ? "next" : "previous";
  selectedWorkflowTabIndex.value = index;
  animateWorkflowTabPanel(index, direction);
}

const WORKFLOW_RUNS_PAGE_SIZE = 10;

// The history is paged (previous/next), so `runList` only holds the page in
// view. Everything the selected run needs falls back to `selectedRunDetail`,
// which keeps working when the run isn't on the current page.
const {
  items: runList,
  isFetching: isFetchingRuns,
  hasPrevPage: hasPrevRunsPage,
  hasNextPage: hasNextRunsPage,
  nextPage: nextRunsPage,
  prevPage: prevRunsPage,
  refresh: refreshRuns,
} = useCursorPagedList<RunSummary>({
  queryKey: computed(() => ["workflow_runs", props.spaceId, props.documentId]),
  fetcher: async ({ limit, cursor }) => {
    const page = await api.workflows.listRuns(props.spaceId, {
      filterDocumentId: props.documentId,
      limit,
      cursor,
    });
    return { items: page.runs, nextCursor: page.nextCursor ?? null };
  },
  pageSize: WORKFLOW_RUNS_PAGE_SIZE,
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
  void router.replace({
    query: { ...router.currentRoute.value.query, run: runId },
    hash: "",
  });
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
    try {
      selectedRunResult.value = await fetchResultArtifact(detail);
    } catch (err) {
      selectedRunResult.value = null;
      selectedRunError.value =
        err instanceof Error ? err.message : "Failed to load workflow result";
    }
  } catch (err) {
    if (selectedRunId.value !== runId) return;
    selectedRunDetail.value = null;
    selectedRunResult.value = null;
    selectedRunError.value =
      err instanceof Error ? err.message : "Failed to load workflow run";
  }
}

async function selectRun(runId: string, options: { updateUrl?: boolean } = {}) {
  if (options.updateUrl ?? true) setRunSearchParam(runId);
  selectedRunId.value = runId;
  selectedRunResult.value = null;
  await fetchSelectedRunDetail();
}

// On mobile the history is a tab, so jump back to the results of the run that
// was just picked instead of leaving the user on the list.
function selectRunFromHistoryTab(runId: string) {
  void selectRun(runId);
  workflowTabsEl.value?.selectTabByIndex(0);
}

const retrying = ref(false);
const retryError = ref<string | null>(null);

// Retry a failed or cancelled run: starts a new run seeded from this one's
// cached step results, so completed steps replay instantly and only the
// failed/changed steps re-execute. Selects the new run so its progress is shown.
async function retrySelectedRun() {
  if (!selectedRunId.value || retrying.value) return;
  retrying.value = true;
  retryError.value = null;
  try {
    const { runId } = await api.workflows.retryRun(props.spaceId, selectedRunId.value);
    await selectRun(runId);
  } catch (err) {
    retryError.value = err instanceof Error ? err.message : "Failed to retry run";
  } finally {
    retrying.value = false;
  }
}

const canRetrySelectedRun = computed(
  () =>
    selectedRunDetail.value?.status === "failed" ||
    selectedRunDetail.value?.status === "cancelled",
);

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

// Router navigations don't fire `popstate`, so the query param is watched
// separately. This is how a run started from the header button (a different
// part of the tree) switches the view over to it.
watch(
  () => router.currentRoute.value.query.run,
  (value) => {
    const runId = typeof value === "string" ? value.trim() : null;
    if (!runId || runId === selectedRunId.value) return;
    void selectRun(runId, { updateUrl: false });
  },
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

async function fetchResultArtifact(
  run: WorkflowRunStatus,
): Promise<Record<string, unknown> | null> {
  if (!run.resultArtifact) return null;
  const response = await fetch(run.resultArtifact.url);
  if (!response.ok) throw new Error(`Unable to load workflow result: ${response.status}`);
  const result: unknown = await response.json();
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;
}

// Job values may use { type: "text", value } or { type: "file", url } envelopes.
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
  unwrapOutputValue(selectedRunResult.value?.html),
);

const outputDocumentId = computed<string | null>(() =>
  unwrapOutputValue(selectedRunResult.value?.documentId),
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

const outputData = computed(() => extractTableData(selectedRunResult.value));

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

const isSelectedRunActive = computed(
  () =>
    selectedRunDetail.value?.status === "pending" ||
    selectedRunDetail.value?.status === "running",
);

const activeRunPhase = computed(() => {
  if (selectedRunDetail.value?.status === "pending") return "Getting things ready";
  if ((selectedRunDetail.value?.logs.length ?? 0) === 0) return "Starting your workflow";
  return "Working through the steps";
});

const recentActivity = computed(() => {
  const logs = selectedRunDetail.value?.logs.filter(Boolean) ?? [];
  const firstVisibleLog = Math.max(0, logs.length - 3);
  return logs.slice(firstVisibleLog).map((message, index) => ({
    id: `${selectedRunId.value}-${firstVisibleLog + index}`,
    message,
    isLatest: firstVisibleLog + index === logs.length - 1,
  }));
});

// A View Transition so new entries push the existing ones down rather than
// snapping — the FLIP move the old `move-class` provided.
const visibleActivity = useViewTransitionList(() => recentActivity.value);

// The script has one flat log stream; job messages include their job identifier.
const allLogs = computed(() => {
  if (!selectedRunDetail.value) return [];
  return [
    ...selectedRunDetail.value.logs.map((line) => ({ line, isError: false })),
    ...(selectedRunDetail.value.error
      ? [{ line: selectedRunDetail.value.error, isError: true }]
      : []),
  ];
});

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

  <div
    class="px-xs lg:px-xl mx-auto mb-12 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-12"
  >
    <div class="min-w-0 space-y-8">
      <div class="flex justify-between gap-4">
        <!-- Title -->
        <h2 class="text-size-title font-semibold text-neutral-800">
          {{ selectedRunTitle || "Untitled" }}
        </h2>

        <!-- Header -->
        <div class="flex items-center justify-between gap-12">
          <div class="flex items-center gap-3">
            <span v-if="selectedRunCreatedAt" class="text-size-small text-neutral-400">
              {{ formatDateTime(selectedRunCreatedAt) }}
            </span>
            <div v-if="selectedRunDetail" class="flex items-center gap-3">
              <span
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-size-medium font-medium capitalize"
                :class="statusBadgeClass[selectedRunDetail.status] ?? 'bg-neutral-100 text-neutral-500'"
              >
                <div
                  v-if="selectedRunDetail.status === 'running' || selectedRunDetail.status === 'pending'"
                  class="svg-icon w-3 h-3 animate-spin"
                  v-html="spinnerIcon"
                />
                {{ selectedRunDetail.status }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabs: Results / Run Details / History -->
      <a-tabs ref="workflowTabsEl" @tab-selected="handleWorkflowTabSelected">
        <a-tabs-list class="block py-4xs overflow-clip">
          <a-tabs-tab
            class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label hover:[&_span]:bg-gray-200 [&[selected]]:opacity-100 opacity-60 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
          >
            <span
              class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
              >Results</span
            >
          </a-tabs-tab>
          <a-tabs-tab
            class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label hover:[&_span]:bg-gray-200 [&[selected]]:opacity-100 opacity-60 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
          >
            <span
              class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
              >Run Details</span
            >
          </a-tabs-tab>
          <!-- On desktop the history lives in the sidebar instead of a tab. -->
          <a-tabs-tab
            class="lg:hidden inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label hover:[&_span]:bg-gray-200 [&[selected]]:opacity-100 opacity-60 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
          >
            <span
              class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
              >History</span
            >
          </a-tabs-tab>
        </a-tabs-list>

        <!-- Results panel -->
        <a-tabs-panel>
          <div class="space-y-4 pt-4">
            <section
              v-if="isSelectedRunActive"
              class="relative overflow-hidden rounded-xl border border-sky-100 bg-[linear-gradient(135deg,rgba(240,249,255,0.9),rgba(255,255,255,0.96)_55%,rgba(236,253,245,0.8))] p-5 shadow-[0_8px_24px_rgba(14,116,144,0.08)] dark:border-sky-900/50 dark:bg-[linear-gradient(135deg,rgba(12,74,110,0.2),rgba(23,23,23,0.96)_55%,rgba(6,78,59,0.2))]"
              aria-live="polite"
            >
              <div
                class="absolute -right-12 -top-16 h-40 w-40 rounded-full bg-sky-200/25 blur-3xl dark:bg-sky-500/10"
              />
              <div class="relative space-y-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="flex items-start gap-3">
                    <div
                      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600 shadow-inner shadow-sky-200/60 dark:bg-sky-900/50 dark:text-sky-300 dark:shadow-none"
                    >
                      <div
                        class="svg-icon h-5 w-5 animate-spin"
                        v-html="spinnerQuarterIcon"
                      />
                    </div>
                    <div>
                      <p class="font-semibold text-neutral-800">
                        Your workflow is in progress
                      </p>
                      <p class="mt-0.5 text-size-small text-neutral-500">
                        {{ activeRunPhase }}
                      </p>
                    </div>
                  </div>
                  <span
                    class="rounded-full border border-sky-200 bg-white/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300"
                  >
                    Working
                  </span>
                </div>

                <div>
                  <div
                    class="relative h-1.5 overflow-hidden rounded-full bg-sky-100 dark:bg-sky-950/70"
                  >
                    <div
                      class="absolute inset-y-0 w-1/3 rounded-full bg-[linear-gradient(90deg,transparent,rgba(14,165,233,0.95),transparent)] animate-workflow-progress motion-reduce:animate-none motion-reduce:translate-x-full"
                    />
                  </div>
                </div>

                <div
                  v-if="recentActivity.length"
                  class="border-t border-sky-100/80 pt-3 dark:border-sky-900/60"
                >
                  <div class="mb-2 flex items-center justify-between gap-3">
                    <span
                      class="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-400"
                    >
                      Recent activity
                    </span>
                    <span class="text-[10px] text-neutral-400">
                      {{ selectedRunDetail?.logs.length }}
                      updates
                    </span>
                  </div>
                  <div class="space-y-1.5">
                    <div
                      v-for="activity in visibleActivity"
                      :key="activity.id"
                      class="flex min-w-0 items-center gap-2 text-size-small"
                      :class="activity.isLatest ? 'text-neutral-700' : 'text-neutral-400'"
                      :style="{ viewTransitionName: viewTransitionName('vt-run-activity', activity.id) }"
                    >
                      <span
                        class="h-1.5 w-1.5 shrink-0 rounded-full"
                        :class="activity.isLatest ? 'bg-sky-500 animate-pulse' : 'bg-neutral-300'"
                      />
                      <span class="truncate" :title="activity.message"
                        >{{ activity.message }}</span
                      >
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <template v-else-if="selectedRunDetail?.status === 'completed'">
              <!-- HTML output -->
              <div
                v-if="outputHtml"
                class="rounded-xl border border-neutral-200 overflow-hidden"
              >
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
                <!-- Raw JSON artifact -->
                <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
                <a
                  v-if="selectedRunDetail?.resultArtifact"
                  :href="selectedRunDetail.resultArtifact.url"
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
                >
                  <div
                    class="svg-icon w-4 h-4 text-neutral-400"
                    v-html="arrowDownTrayIcon"
                  />
                  Result JSON
                </a>

                <!-- Document link -->
                <!-- biome-ignore lint/a11y/useValidAnchor: href is supplied by Vue's dynamic binding. -->
                <a
                  v-if="outputDocumentId && outputDocumentHref"
                  :href="outputDocumentHref"
                  class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-sky-300 hover:bg-sky-50 dark:hover:border-neutral-300 dark:hover:bg-neutral-200 transition-colors text-size-medium font-medium text-neutral-800"
                >
                  <div class="svg-icon w-4 h-4 text-neutral-400" v-html="documentIcon" />
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
                    <div
                      class="svg-icon w-4 h-4 text-neutral-400"
                      v-html="fileAttachmentIcon"
                    />
                    {{ selectedRunFileName }}
                  </a>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-neutral-200 bg-white dark:bg-neutral-100 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-size-medium text-neutral-500"
                    title="Download"
                    @click="downloadFile(selectedRunFileUrl!, selectedRunFileName!, selectedRunTitle ?? selectedRunFileName!)"
                  >
                    <div class="svg-icon w-4 h-4" v-html="downloadIcon" />
                  </button>
                </template>
              </div>

              <p
                v-if="!outputHtml && !outputData && !outputDocumentId && !selectedRunFileUrl && !selectedRunDetail?.resultArtifact"
                class="text-size-medium text-neutral-400"
              >
                No output
              </p>
            </template>

            <div v-else-if="canRetrySelectedRun" class="space-y-3">
              <p class="text-size-medium text-red-600">
                {{ selectedRunDetail?.error ?? (selectedRunDetail?.status === 'cancelled' ? 'Run cancelled.' : 'Run failed.') }}
              </p>
              <button
                type="button"
                class="inline-flex items-center gap-2 px-3 py-1.5 text-size-medium font-medium rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                :disabled="retrying"
                title="Start a new run, replaying already-completed steps from cache"
                @click="retrySelectedRun"
              >
                <div
                  v-if="retrying"
                  class="svg-icon w-3.5 h-3.5 animate-spin"
                  v-html="spinnerIcon"
                />
                <div v-else class="svg-icon w-3.5 h-3.5" v-html="refreshIcon" />
                {{ retrying ? "Retrying…" : "Retry" }}
              </button>
              <p v-if="retryError" class="text-size-small text-red-600">
                {{ retryError }}
              </p>
            </div>

            <p v-else class="text-size-medium text-neutral-400">
              {{ !selectedRunDetail ? (selectedRunError ?? 'Select a run from History to see results.') : 'Run did not complete.' }}
            </p>
          </div>
        </a-tabs-panel>

        <!-- Run Details panel -->
        <a-tabs-panel>
          <div class="space-y-6 pt-4">
            <!-- Input fields -->
            <div v-if="selectedRunInputs">
              <div
                class="mb-2 text-size-small font-medium text-neutral-500 uppercase tracking-wide"
              >
                Input fields
              </div>
              <div
                class="grid grid-cols-[180px_1fr] items-center h-9 border-b border-neutral-100 bg-neutral-50 transition-colors"
              >
                <div
                  class="px-4 text-size-small font-medium text-neutral-500 uppercase tracking-wide"
                >
                  Field
                </div>
                <div
                  class="pr-4 text-size-small font-medium text-neutral-500 uppercase tracking-wide"
                >
                  Value
                </div>
              </div>
              <div>
                <div
                  v-for="(val, key) in selectedRunInputs"
                  :key="key"
                  class="border-b border-neutral-100 transition-colors hover:bg-neutral-50"
                >
                  <div class="grid grid-cols-[180px_1fr] items-center text-size-medium">
                    <div
                      class="px-4 py-2.5 font-mono text-[11px] font-medium text-neutral-500 truncate"
                    >
                      {{ key }}
                    </div>
                    <pre
                      class="px-0 py-2.5 pr-4 overflow-x-auto whitespace-pre-wrap break-all text-size-small text-neutral-700"
                    >{{ typeof val === 'object' ? JSON.stringify(val, null, 2) : val }}</pre>
                  </div>
                </div>
              </div>
            </div>

            <!-- Logs -->
            <div
              v-if="allLogs.length > 0"
              class="flex flex-col p-4 bg-neutral-950 dark:bg-neutral-50 rounded-lg"
            >
              <div class="text-size-small text-neutral-400">Logs</div>
              <div class="mt-2 w-full overflow-x-auto max-h-[400px]">
                <div class="font-mono text-[11px] space-y-0.5">
                  <div v-for="(entry, i) in allLogs" :key="i" class="flex gap-3">
                    <span
                      :class="entry.isError ? 'text-red-400' : 'text-neutral-300 dark:text-neutral-600'"
                      >{{ entry.line }}</span
                    >
                  </div>
                </div>
              </div>
            </div>

            <p
              v-if="!selectedRunInputs && allLogs.length === 0"
              class="text-size-medium text-neutral-400"
            >
              No details available.
            </p>
          </div>
        </a-tabs-panel>

        <!-- History panel (mobile only; desktop renders the sidebar below) -->
        <a-tabs-panel>
          <div class="pt-2 lg:hidden">
            <WorkflowRunHistory
              :runs="runList"
              :selectedRunId="selectedRunId"
              :hasPrevPage="hasPrevRunsPage"
              :hasNextPage="hasNextRunsPage"
              :busy="isFetchingRuns"
              @select="selectRunFromHistoryTab"
              @prev="prevRunsPage"
              @next="nextRunsPage"
            />
          </div>
        </a-tabs-panel>
      </a-tabs>
    </div>

    <aside class="hidden min-w-0 lg:block">
      <h3
        class="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-400 mb-2"
      >
        History
      </h3>
      <WorkflowRunHistory
        :runs="runList"
        :selectedRunId="selectedRunId"
        :hasPrevPage="hasPrevRunsPage"
        :hasNextPage="hasNextRunsPage"
        :busy="isFetchingRuns"
        @select="(runId: string) => selectRun(runId)"
        @prev="prevRunsPage"
        @next="nextRunsPage"
      />
    </aside>
  </div>
</template>
