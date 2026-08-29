import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { WorkflowRunStatus } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { useViewTransitionList } from "#composeables/useViewTransitionList.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { formatDateTime } from "#utils/dateFormat.ts";
import { isSafeUrlValue, sanitizeVektorDocumentPreviewHtml } from "#utils/html.ts";
import { spacePath } from "#utils/utils.ts";
import { viewTransitionName } from "#utils/viewTransition.ts";
import { downloadExcelRows, parseCsvRows } from "#utils/xlsx.ts";
import "@atrium-ui/elements/tabs";
import { DataTable } from "./DataTable.tsx";
import { Icon } from "./Icon.tsx";
import { Tab, TabsList } from "./Tabs.tsx";
import { WorkflowRunHistory } from "./WorkflowRunHistory.tsx";

interface Props {
  documentId: string;
  spaceId: string;
}

type RunSummary = {
  runId: string;
  documentId: string;
  status: string;
  createdAt: string;
  sourceExtensionId: string | null;
  runtimeInputs: Record<string, unknown>;
};

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};

const WORKFLOW_RUNS_PAGE_SIZE = 10;

const HISTORY_TAB_INDEX = 2;

const statusBadgeClass: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-500",
  running: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400",
  completed:
    "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400",
  failed: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
  cancelled: "bg-neutral-100 text-neutral-400",
};

function unwrapOutputValue(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    const v = val as Record<string, unknown>;
    if (v.type === "text" && typeof v.value === "string") return v.value;
    if (v.type === "file" && typeof v.url === "string") return v.url;
  }
  return null;
}

function extractTableData(
  output: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] | null {
  let raw: unknown = output?.data ?? output?.result;
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

export function WorkflowView(props: Props) {
  const lang = useLocale();
  const { currentSpace } = useSpace();
  const navigate = useNavigate();
  const location = useLocation();

  const [sourceExtensionHref, setSourceExtensionHref] = createSignal<string | null>(null);
  const [selectedRunId, setSelectedRunId] = createSignal<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] =
    createSignal<WorkflowRunStatus | null>(null);
  const [selectedRunResult, setSelectedRunResult] = createSignal<Record<
    string,
    unknown
  > | null>(null);
  const [selectedRunError, setSelectedRunError] = createSignal<string | null>(null);
  let unsubscribeRuns: (() => void) | null = null;
  let unsubscribeRun: (() => void) | null = null;
  const foreignRunIds = new Set<string>();

  let workflowTabsEl: ATabsEl | undefined;
  let workflowContainerEl: HTMLDivElement | undefined;
  let historySidebarEl: HTMLElement | undefined;
  let selectedWorkflowTabIndex = 0;

  function selectWorkflowTab(index: number, focus = true) {
    workflowTabsEl?.selectTabByIndex(index, focus);
    selectedWorkflowTabIndex = index;
  }

  const [breadcrumbSlot, setBreadcrumbSlot] = createSignal<HTMLElement | null>(null);

  function animateWorkflowTabPanel(index: number, direction: "next" | "previous") {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    requestAnimationFrame(() => {
      const panel = workflowTabsEl?.querySelectorAll("a-tabs-panel").item(index);
      const content = panel?.firstElementChild as HTMLElement | null;
      if (!content) return;

      for (const animation of content.getAnimations()) animation.cancel();

      const easing = getComputedStyle(document.documentElement)
        .getPropertyValue("--emphasized-curve")
        .trim();
      content.animate(
        [
          { opacity: 0, transform: `translateX(${direction === "next" ? 8 : -8}px)` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 180, easing: easing || "ease-out" },
      );
    });
  }

  function handleWorkflowTabSelected(event: Event) {
    const { index } = (event as CustomEvent<{ index: number }>).detail;
    if (index === selectedWorkflowTabIndex) return;

    const direction = index > selectedWorkflowTabIndex ? "next" : "previous";
    selectedWorkflowTabIndex = index;
    animateWorkflowTabPanel(index, direction);
  }

  const {
    items: fetchedRuns,
    isFetching: isFetchingRuns,
    hasPrevPage: hasPrevRunsPage,
    hasNextPage: hasNextRunsPage,
    nextPage: nextRunsPage,
    prevPage: prevRunsPage,
    refresh: refreshRuns,
  } = useCursorPagedList<RunSummary>({
    queryKey: createMemo(() => ["workflow_runs", props.spaceId, props.documentId]),
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

  const runList = createMemo(() =>
    fetchedRuns().filter((run) => run.documentId === props.documentId),
  );

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
    const query = new URLSearchParams(location.search);
    query.set("run", runId);
    navigate(`${location.pathname}?${query.toString()}`, {
      replace: true,
      resolve: false,
    });
  }

  createEffect(
    on(selectedRunId, (runId) => {
      unsubscribeRun?.();
      unsubscribeRun = null;
      if (!runId) return;
      unsubscribeRun = api.subscribeToTopics(
        props.spaceId,
        [realtimeTopics.workflowRun(runId)],
        () => {
          void fetchSelectedRunDetail();
        },
      );
    }),
  );

  async function fetchSelectedRunDetail() {
    const runId = selectedRunId();
    if (!runId) return;
    try {
      const detail = await api.workflows.getRun(props.spaceId, runId);
      if (selectedRunId() !== runId) return;
      if (detail.documentId && detail.documentId !== props.documentId) {
        foreignRunIds.add(runId);
        setSelectedRunId(null);
        setSelectedRunDetail(null);
        setSelectedRunResult(null);
        setSelectedRunError(null);
        return;
      }
      setSelectedRunDetail(detail);
      setSelectedRunError(null);
      try {
        setSelectedRunResult(await fetchResultArtifact(detail));
      } catch (err) {
        setSelectedRunResult(null);
        setSelectedRunError(
          err instanceof Error ? err.message : "Failed to load workflow result",
        );
      }
    } catch (err) {
      if (selectedRunId() !== runId) return;
      setSelectedRunDetail(null);
      setSelectedRunResult(null);
      setSelectedRunError(
        err instanceof Error ? err.message : "Failed to load workflow run",
      );
    }
  }

  async function selectRun(runId: string, options: { updateUrl?: boolean } = {}) {
    if (options.updateUrl ?? true) setRunSearchParam(runId);
    setSelectedRunId(runId);
    setSelectedRunResult(null);
    await fetchSelectedRunDetail();
  }

  function selectRunFromHistoryTab(runId: string) {
    void selectRun(runId);
    selectWorkflowTab(0);
  }

  onMount(() => {
    const containerEl = workflowContainerEl;
    if (!containerEl) return;

    const observer = new ResizeObserver(() => {
      if (selectedWorkflowTabIndex !== HISTORY_TAB_INDEX) return;
      if (!historySidebarEl || getComputedStyle(historySidebarEl).display === "none") {
        return;
      }
      selectWorkflowTab(0, false);
    });
    observer.observe(containerEl);
    onCleanup(() => observer.disconnect());
  });

  const [retrying, setRetrying] = createSignal(false);
  const [retryError, setRetryError] = createSignal<string | null>(null);

  async function retrySelectedRun() {
    const currentRunId = selectedRunId();
    if (!currentRunId || retrying()) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const { runId } = await api.workflows.retryRun(props.spaceId, currentRunId);
      await selectRun(runId);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Failed to retry run");
    } finally {
      setRetrying(false);
    }
  }

  const canRetrySelectedRun = createMemo(
    () =>
      selectedRunDetail()?.status === "failed" ||
      selectedRunDetail()?.status === "cancelled",
  );

  const selectedRun = createMemo(() =>
    runList().find((r) => r.runId === selectedRunId()),
  );

  const selectedRunSourceExtensionId = createMemo(
    () =>
      selectedRun()?.sourceExtensionId ?? selectedRunDetail()?.sourceExtensionId ?? null,
  );

  const selectedRunCreatedAt = createMemo(
    () => selectedRun()?.createdAt ?? selectedRunDetail()?.createdAt ?? null,
  );

  const selectedRunTitle = createMemo(() => {
    const title =
      selectedRun()?.runtimeInputs?.title ?? selectedRunDetail()?.runtimeInputs?.title;
    return typeof title === "string" ? title : null;
  });

  const selectedRunFileName = createMemo(() => {
    const name =
      selectedRun()?.runtimeInputs?.fileName ??
      selectedRunDetail()?.runtimeInputs?.fileName;
    return typeof name === "string" ? name : null;
  });

  // Run inputs are caller-supplied JSON, and this one becomes an `href`, so a
  // `javascript:` value would run on click.
  const selectedRunFileUrl = createMemo(() => {
    const file =
      selectedRun()?.runtimeInputs?.file ?? selectedRunDetail()?.runtimeInputs?.file;
    return typeof file === "string" && isSafeUrlValue(file) ? file : null;
  });

  const selectedRunInputs = createMemo(() => {
    const inputs = selectedRun()?.runtimeInputs ?? selectedRunDetail()?.runtimeInputs;
    if (!inputs || Object.keys(inputs).length === 0) return null;
    return inputs;
  });

  createEffect(
    on(
      () => props.documentId,
      () => {
        setSelectedRunId(null);
        setSelectedRunDetail(null);
        setSelectedRunResult(null);
        setSelectedRunError(null);
        setSourceExtensionHref(null);
        const urlRunId = runIdFromUrl();
        if (urlRunId && !foreignRunIds.has(urlRunId)) {
          void selectRun(urlRunId, { updateUrl: false });
        }
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const newRuns = runList();
    if (newRuns.length === 0) return;
    if (selectedRunId()) return;
    const urlRunId = runIdFromUrl();
    const target = urlRunId && !foreignRunIds.has(urlRunId) ? urlRunId : newRuns[0].runId;
    void selectRun(target, { updateUrl: false });
  });

  createEffect(
    on(selectedRunSourceExtensionId, async (sourceExtId) => {
      if (!sourceExtId) {
        setSourceExtensionHref(null);
        return;
      }
      const ext = await api.extensions.getById(props.spaceId, sourceExtId);
      if (selectedRunSourceExtensionId() !== sourceExtId) return;
      const firstRoute = ext.routes?.[0];
      setSourceExtensionHref(
        firstRoute ? spacePath(currentSpace()?.slug, `/x/${firstRoute.path}`) : null,
      );
    }),
  );

  const runParam = createMemo(() => new URLSearchParams(location.search).get("run"));

  createEffect(
    on(
      runParam,
      (value) => {
        const runId = value?.trim() || null;
        if (!runId || runId === selectedRunId()) return;
        void selectRun(runId, { updateUrl: false });
      },
      { defer: true },
    ),
  );

  function handleUrlChange() {
    const runId = runIdFromUrl();
    if (runId && runId !== selectedRunId()) {
      void selectRun(runId, { updateUrl: false });
    } else if (!runId && runList()[0] && runList()[0].runId !== selectedRunId()) {
      void selectRun(runList()[0].runId, { updateUrl: false });
    }
  }

  onMount(() => {
    setBreadcrumbSlot(document.querySelector<HTMLElement>("#workflow-breadcrumb-slot"));

    const urlRunId = runIdFromUrl();
    if (urlRunId && selectedRunId() !== urlRunId) {
      void selectRun(urlRunId, { updateUrl: false });
    }
    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);

    unsubscribeRuns = api.subscribeToTopics(
      props.spaceId,
      [realtimeTopics.workflowRuns],
      async () => {
        refreshRuns();
        if (selectedRunId()) await fetchSelectedRunDetail();
      },
    );

    onCleanup(() => {
      window.removeEventListener("popstate", handleUrlChange);
      window.removeEventListener("hashchange", handleUrlChange);
      unsubscribeRuns?.();
      unsubscribeRun?.();
    });
  });

  // Whatever a workflow script returned, and a script runs server-side with
  // `fetch` — so this can be a third party's bytes. Prose only: a report is read,
  // not edited, and needs none of the document vocabulary.
  const outputHtml = createMemo<string | null>(() => {
    const html = unwrapOutputValue(selectedRunResult()?.html);
    return html === null ? null : sanitizeVektorDocumentPreviewHtml(html) || null;
  });

  const outputDocumentId = createMemo<string | null>(() =>
    unwrapOutputValue(selectedRunResult()?.documentId),
  );

  const outputData = createMemo(() => extractTableData(selectedRunResult()));

  const [outputDocumentHref, setOutputDocumentHref] = createSignal<string | null>(null);
  const [outputDocumentTitle, setOutputDocumentTitle] = createSignal<string | null>(null);

  createEffect(
    on(outputDocumentId, async (id) => {
      if (!id) {
        setOutputDocumentHref(null);
        setOutputDocumentTitle(null);
        return;
      }
      const doc = await api.document.get(props.spaceId, id);
      setOutputDocumentHref(spacePath(currentSpace()?.slug, `/doc/${doc.slug}`));
      setOutputDocumentTitle(
        doc.properties?.title ? propertyValueToText(doc.properties.title) : doc.slug,
      );
    }),
  );

  const isSelectedRunActive = createMemo(
    () =>
      selectedRunDetail()?.status === "pending" ||
      selectedRunDetail()?.status === "running",
  );

  const activeRunPhase = createMemo(() => {
    if (selectedRunDetail()?.status === "pending") return "Getting things ready";
    if ((selectedRunDetail()?.logs.length ?? 0) === 0) return "Starting your workflow";
    return "Working through the steps";
  });

  const recentActivity = createMemo(() => {
    const logs = selectedRunDetail()?.logs.filter(Boolean) ?? [];
    const firstVisibleLog = Math.max(0, logs.length - 3);
    return logs.slice(firstVisibleLog).map((message, index) => ({
      id: `${selectedRunId()}-${firstVisibleLog + index}`,
      message,
      isLatest: firstVisibleLog + index === logs.length - 1,
    }));
  });

  const visibleActivity = useViewTransitionList(
    recentActivity,
    (activity) => activity.id,
  );

  const allLogs = createMemo(() => {
    const detail = selectedRunDetail();
    if (!detail) return [];
    return [
      ...detail.logs.map((line) => ({ line, isError: false })),
      ...(detail.error ? [{ line: detail.error, isError: true }] : []),
    ];
  });

  const historyProps = () => ({
    runs: runList(),
    selectedRunId: selectedRunId(),
    hasPrevPage: hasPrevRunsPage(),
    hasNextPage: hasNextRunsPage(),
    busy: isFetchingRuns(),
    onPrev: prevRunsPage,
    onNext: nextRunsPage,
  });

  return (
    <>
      <Show when={sourceExtensionHref() && breadcrumbSlot()}>
        <Portal mount={breadcrumbSlot() as HTMLElement}>
          <a
            href={sourceExtensionHref() as string}
            class="inline-flex items-center gap-1.5 text-neutral-400 text-size-medium transition-colors hover:text-neutral-600"
          >
            <Icon class="h-4 w-4" name="chevron-left-thin" />
            Back
          </a>
        </Portal>
      </Show>

      <div
        ref={workflowContainerEl}
        class="@container/workflow flex min-h-0 flex-1 flex-col"
      >
        <div class="mx-auto flex @4xl/workflow:grid min-h-0 w-full flex-1 @4xl/workflow:grid-cols-[20rem_minmax(0,1fr)] flex-col">
          <aside
            ref={historySidebarEl}
            class="@4xl/workflow:flex hidden min-h-0 min-w-0 flex-col border-neutral-100 @4xl/workflow:border-r pt-1 pl-xs md:pl-m"
          >
            <h3 class="mb-2 shrink-0 font-semibold text-neutral-400 text-size-extra-small uppercase tracking-[0.12em]">
              History
            </h3>
            <div class="min-h-0 flex-1 overflow-y-auto pr-3 pb-12">
              <WorkflowRunHistory
                {...historyProps()}
                onSelect={(runId: string) => void selectRun(runId)}
              />
            </div>
          </aside>

          <div class="min-h-0 min-w-0 flex-1 space-y-8 overflow-y-auto px-xs pt-1 pb-12 md:px-m">
            <div class="flex justify-between gap-4">
              <h2 class="font-semibold text-neutral-800 text-size-title">
                {selectedRunTitle() || "Untitled"}
              </h2>

              <div class="flex items-center justify-between gap-12">
                <div class="flex items-center gap-3">
                  <Show when={selectedRunCreatedAt()}>
                    {(createdAt) => (
                      <span class="text-neutral-400 text-size-small">
                        {formatDateTime(createdAt(), lang)}
                      </span>
                    )}
                  </Show>
                  <Show when={selectedRunDetail()}>
                    {(detail) => (
                      <div class="flex items-center gap-3">
                        <span
                          class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-size-medium capitalize ${
                            statusBadgeClass[detail().status] ??
                            "bg-neutral-100 text-neutral-500"
                          }`}
                        >
                          <Show
                            when={
                              detail().status === "running" ||
                              detail().status === "pending"
                            }
                          >
                            <Icon class="h-3 w-3 animate-spin" name="spinner" />
                          </Show>
                          {detail().status}
                        </span>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </div>

            <a-tabs
              ref={workflowTabsEl as never}
              on:tab-selected={handleWorkflowTabSelected}
            >
              <TabsList class="border-neutral-100 border-b">
                <Tab>Results</Tab>
                <Tab>Run Details</Tab>
                <Tab class="@4xl/workflow:hidden">History</Tab>
              </TabsList>

              <a-tabs-panel>
                <div class="space-y-4 pt-4">
                  <Show when={isSelectedRunActive()}>
                    <section
                      class="relative overflow-hidden rounded-xl border border-sky-100 bg-[linear-gradient(135deg,rgba(240,249,255,0.9),rgba(255,255,255,0.96)_55%,rgba(236,253,245,0.8))] p-5 shadow-[0_8px_24px_rgba(14,116,144,0.08)] dark:border-sky-900/50 dark:bg-[linear-gradient(135deg,rgba(12,74,110,0.2),rgba(23,23,23,0.96)_55%,rgba(6,78,59,0.2))]"
                      aria-live="polite"
                    >
                      <div class="absolute -top-16 -right-12 h-40 w-40 rounded-full bg-sky-200/25 blur-3xl dark:bg-sky-500/10" />
                      <div class="relative space-y-5">
                        <div class="flex items-start justify-between gap-4">
                          <div class="flex items-start gap-3">
                            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600 shadow-inner shadow-sky-200/60 dark:bg-sky-900/50 dark:text-sky-300 dark:shadow-none">
                              <Icon class="h-5 w-5 animate-spin" name="spinner" />
                            </div>
                            <div>
                              <p class="font-semibold text-neutral-800">
                                Your workflow is in progress
                              </p>
                              <p class="mt-0.5 text-neutral-500 text-size-small">
                                {activeRunPhase()}
                              </p>
                            </div>
                          </div>
                          <span class="rounded-full border border-sky-200 bg-white/70 px-2.5 py-1 font-semibold text-size-extra-small text-sky-700 uppercase tracking-[0.1em] dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
                            Working
                          </span>
                        </div>

                        <div>
                          <div class="relative h-1.5 overflow-hidden rounded-full bg-sky-100 dark:bg-sky-950/70">
                            <div class="absolute inset-y-0 w-1/3 animate-workflow-progress rounded-full bg-[linear-gradient(90deg,transparent,rgba(14,165,233,0.95),transparent)] motion-reduce:translate-x-full motion-reduce:animate-none" />
                          </div>
                        </div>

                        <Show when={recentActivity().length}>
                          <div class="border-sky-100/80 border-t pt-3 dark:border-sky-900/60">
                            <div class="mb-2 flex items-center justify-between gap-3">
                              <span class="font-semibold text-neutral-400 text-size-extra-small uppercase tracking-[0.12em]">
                                Recent activity
                              </span>
                              <span class="text-neutral-400 text-size-extra-small">
                                {selectedRunDetail()?.logs.length} updates
                              </span>
                            </div>
                            <div class="space-y-1.5">
                              <For each={visibleActivity()}>
                                {(activity) => (
                                  <div
                                    class="flex min-w-0 items-center gap-2 text-size-small"
                                    classList={{
                                      "text-neutral-700": activity.isLatest,
                                      "text-neutral-400": !activity.isLatest,
                                    }}
                                    style={{
                                      "view-transition-name": viewTransitionName(
                                        "vt-run-activity",
                                        activity.id,
                                      ),
                                    }}
                                  >
                                    <span
                                      class="h-1.5 w-1.5 shrink-0 rounded-full"
                                      classList={{
                                        "animate-pulse bg-sky-500": activity.isLatest,
                                        "bg-neutral-300": !activity.isLatest,
                                      }}
                                    />
                                    <span class="truncate" title={activity.message}>
                                      {activity.message}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </div>
                    </section>
                  </Show>

                  <Show
                    when={
                      !isSelectedRunActive() &&
                      selectedRunDetail()?.status === "completed"
                    }
                  >
                    <Show when={outputHtml()}>
                      {(html) => (
                        <div class="overflow-hidden rounded-xl border border-neutral-200">
                          <div innerHTML={html()} class="p-2" />
                        </div>
                      )}
                    </Show>

                    <Show when={outputData()}>
                      {(data) => (
                        <DataTable
                          data={data()}
                          documentId={props.documentId}
                          exportFileName={selectedRunTitle() ?? "data"}
                        />
                      )}
                    </Show>

                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={selectedRunDetail()?.resultArtifact}>
                        {(artifact) => (
                          <a
                            href={artifact().url}
                            target="_blank"
                            rel="noreferrer"
                            class="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 font-medium text-neutral-800 text-size-medium transition-colors hover:border-sky-300 hover:bg-sky-50 dark:bg-neutral-100 dark:hover:border-neutral-300 dark:hover:bg-neutral-200"
                          >
                            <Icon class="h-4 w-4 text-neutral-400" name="download" />
                            Result JSON
                          </a>
                        )}
                      </Show>

                      <Show when={outputDocumentId() && outputDocumentHref()}>
                        <a
                          href={outputDocumentHref() as string}
                          class="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 font-medium text-neutral-800 text-size-medium transition-colors hover:border-sky-300 hover:bg-sky-50 dark:bg-neutral-100 dark:hover:border-neutral-300 dark:hover:bg-neutral-200"
                        >
                          <Icon class="h-4 w-4 text-neutral-400" name="document" />
                          {outputDocumentTitle() ?? "Open document"}
                        </a>
                      </Show>

                      <Show when={selectedRunFileUrl() && selectedRunFileName()}>
                        <a
                          href={selectedRunFileUrl() as string}
                          target="_blank"
                          rel="noreferrer"
                          class="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 font-medium text-neutral-800 text-size-medium transition-colors hover:border-sky-300 hover:bg-sky-50 dark:bg-neutral-100 dark:hover:border-neutral-300 dark:hover:bg-neutral-200"
                        >
                          <Icon class="h-4 w-4 text-neutral-400" name="file-attachment" />
                          {selectedRunFileName()}
                        </a>
                        <button
                          type="button"
                          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-neutral-500 text-size-medium transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:bg-neutral-100"
                          title="Download"
                          onClick={() =>
                            void downloadFile(
                              selectedRunFileUrl() as string,
                              selectedRunFileName() as string,
                              selectedRunTitle() ?? (selectedRunFileName() as string),
                            )
                          }
                        >
                          <Icon class="h-4 w-4" name="download" />
                        </button>
                      </Show>
                    </div>

                    <Show
                      when={
                        !outputHtml() &&
                        !outputData() &&
                        !outputDocumentId() &&
                        !selectedRunFileUrl() &&
                        !selectedRunDetail()?.resultArtifact
                      }
                    >
                      <p class="text-neutral-400 text-size-medium">No output</p>
                    </Show>
                  </Show>

                  <Show
                    when={
                      !isSelectedRunActive() &&
                      selectedRunDetail()?.status !== "completed" &&
                      canRetrySelectedRun()
                    }
                  >
                    <div class="space-y-3">
                      <p class="text-red-600 text-size-medium">
                        {selectedRunDetail()?.error ??
                          (selectedRunDetail()?.status === "cancelled"
                            ? "Run cancelled."
                            : "Run failed.")}
                      </p>
                      <button
                        type="button"
                        class="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-size-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                        disabled={retrying()}
                        title="Start a new run, replaying already-completed steps from cache"
                        onClick={() => void retrySelectedRun()}
                      >
                        <Show
                          when={retrying()}
                          fallback={<Icon class="h-3.5 w-3.5" name="refresh" />}
                        >
                          <Icon class="h-3.5 w-3.5 animate-spin" name="spinner" />
                        </Show>
                        {retrying() ? "Retrying…" : "Retry"}
                      </button>
                      <Show when={retryError()}>
                        <p class="text-red-600 text-size-small">{retryError()}</p>
                      </Show>
                    </div>
                  </Show>

                  <Show
                    when={
                      !isSelectedRunActive() &&
                      selectedRunDetail()?.status !== "completed" &&
                      !canRetrySelectedRun()
                    }
                  >
                    <p class="text-neutral-400 text-size-medium">
                      {!selectedRunDetail()
                        ? (selectedRunError() ??
                          "Select a run from History to see results.")
                        : "Run did not complete."}
                    </p>
                  </Show>
                </div>
              </a-tabs-panel>

              <a-tabs-panel>
                <div class="space-y-6 pt-4">
                  <Show when={selectedRunInputs()}>
                    {(inputs) => (
                      <div>
                        <div class="mb-2 font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                          Input fields
                        </div>
                        <div class="grid h-9 grid-cols-[180px_1fr] items-center border-neutral-100 border-b bg-neutral-50 transition-colors">
                          <div class="px-4 font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                            Field
                          </div>
                          <div class="pr-4 font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                            Value
                          </div>
                        </div>
                        <div>
                          <For each={Object.entries(inputs())}>
                            {([key, val]) => (
                              <div class="border-neutral-100 border-b transition-colors hover:bg-neutral-50">
                                <div class="grid grid-cols-[180px_1fr] items-center text-size-medium">
                                  <div class="truncate px-4 py-2.5 font-medium font-mono text-neutral-500 text-size-extra-small">
                                    {key}
                                  </div>
                                  <pre class="overflow-x-auto whitespace-pre-wrap break-all px-0 py-2.5 pr-4 text-neutral-700 text-size-small">
                                    {typeof val === "object"
                                      ? JSON.stringify(val, null, 2)
                                      : String(val)}
                                  </pre>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={allLogs().length > 0}>
                    <div class="flex flex-col rounded-lg bg-neutral-950 p-4 dark:bg-neutral-50">
                      <div class="text-neutral-400 text-size-small">Logs</div>
                      <div class="mt-2 max-h-[400px] w-full overflow-x-auto">
                        <div class="space-y-0.5 font-mono text-size-extra-small">
                          <For each={allLogs()}>
                            {(entry) => (
                              <div class="flex gap-3">
                                <span
                                  classList={{
                                    "text-red-400": entry.isError,
                                    "text-neutral-300 dark:text-neutral-600":
                                      !entry.isError,
                                  }}
                                >
                                  {entry.line}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </div>
                  </Show>

                  <Show when={!selectedRunInputs() && allLogs().length === 0}>
                    <p class="text-neutral-400 text-size-medium">No details available.</p>
                  </Show>
                </div>
              </a-tabs-panel>

              <a-tabs-panel>
                <div class="@4xl/workflow:hidden pt-2">
                  <WorkflowRunHistory
                    {...historyProps()}
                    onSelect={selectRunFromHistoryTab}
                  />
                </div>
              </a-tabs-panel>
            </a-tabs>
          </div>
        </div>
      </div>
    </>
  );
}
