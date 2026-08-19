import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { api, type JobRun, type WorkflowSchedule } from "#api/client.ts";
import { useInfiniteQuery } from "#composeables/query.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { formatDateTime } from "#utils/dateFormat.ts";
import { Button } from "./Button.tsx";
import { PagerCursor } from "./PagerCursor.tsx";

type WorkflowRunsPage = Awaited<ReturnType<typeof api.workflows.listRuns>>;
type WorkflowRunRow = WorkflowRunsPage["runs"][number];

interface AvailableWorkflow {
  id: string;
  title: string;
}

interface AvailableJob {
  id: string;
  name: string;
  extensionName: string;
}

const WORKFLOW_RUNS_PAGE_SIZE = 25;

function statusClasses(status: string): string {
  switch (status) {
    case "success":
    case "completed":
      return "bg-green-100 text-green-700";
    case "failed":
    case "timeout":
      return "bg-red-100 text-red-700";
    case "cancelled":
      return "bg-yellow-100 text-yellow-700";
    case "running":
      return "bg-blue-100 text-blue-700";
    default:
      return "bg-neutral-100 text-neutral-600";
  }
}

function formatDuration(run: JobRun): string {
  if (!run.startedAt) return "—";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const ms = end - new Date(run.startedAt).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function JobsSettings() {
  const { currentSpace, currentSpaceId } = useSpace();
  const navigate = useNavigate();

  const [schedules, setSchedules] = createSignal<WorkflowSchedule[]>([]);
  const [isLoadingSchedules, setIsLoadingSchedules] = createSignal(false);
  const [scheduleError, setScheduleError] = createSignal<string | null>(null);
  const [isCreatingSchedule, setIsCreatingSchedule] = createSignal(false);
  const [isSubmittingSchedule, setIsSubmittingSchedule] = createSignal(false);
  const [newScheduleDocumentId, setNewScheduleDocumentId] = createSignal("");
  const [newScheduleCron, setNewScheduleCron] = createSignal("");
  const [newScheduleTimezone, setNewScheduleTimezone] = createSignal("");

  const [availableWorkflows, setAvailableWorkflows] = createSignal<AvailableWorkflow[]>(
    [],
  );
  const [availableJobs, setAvailableJobs] = createSignal<AvailableJob[]>([]);

  const {
    data: workflowRunsData,
    isLoading: isLoadingWorkflowRuns,
    error: workflowRunsQueryError,
    fetchNextPage: fetchNextWorkflowRunsPage,
    hasNextPage: hasMoreWorkflowRuns,
    isFetchingNextPage: isFetchingNextWorkflowRunsPage,
    refetch: refreshWorkflowRuns,
  } = useInfiniteQuery<WorkflowRunsPage, string | undefined>({
    queryKey: createMemo(() => ["workflow_runs", currentSpace()?.id]),
    queryFn: ({ pageParam }) =>
      api.workflows.listRuns(currentSpace()?.id ?? "", {
        limit: WORKFLOW_RUNS_PAGE_SIZE,
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
    enabled: createMemo(() => !!currentSpace()?.id),
  });

  const workflowRuns = createMemo<WorkflowRunRow[]>(
    () => workflowRunsData()?.pages.flatMap((page) => page.runs) ?? [],
  );

  const {
    items: runs,
    isLoading: isLoadingRuns,
    isFetching: isFetchingRuns,
    error: runsQueryError,
    hasPrevPage: runsHasPrevPage,
    hasNextPage: runsHasNextPage,
    nextPage: runsNextPage,
    prevPage: runsPrevPage,
    refresh: refreshRuns,
  } = useCursorPagedList({
    queryKey: createMemo(() => ["job_runs", currentSpace()?.id]),
    fetcher: ({ limit, cursor }) =>
      api.jobs.listRuns(currentSpace()?.id ?? "", { limit, cursor }).then((r) => ({
        items: r.runs,
        nextCursor: r.nextCursor,
      })),
    enabled: createMemo(() => !!currentSpace()?.id),
    pageSize: 25,
  });

  const [expandedRunId, setExpandedRunId] = createSignal<string | null>(null);

  function workflowName(documentId: string): string {
    return availableWorkflows().find((w) => w.id === documentId)?.title ?? documentId;
  }

  function goToWorkflowRun(run: WorkflowRunRow) {
    navigate(
      `/doc/${run.documentSlug ?? run.documentId}?run=${encodeURIComponent(run.runId)}`,
    );
  }

  function jobName(jobId: string): string {
    return availableJobs().find((j) => j.id === jobId)?.name ?? jobId;
  }

  async function loadAvailableJobs() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    try {
      const { extensions } = await api.extensions.get(spaceId);
      setAvailableJobs(
        extensions.flatMap(
          (ext) =>
            ext.jobs?.map((job) => ({
              id: job.id,
              name: job.name,
              extensionName: ext.name,
            })) ?? [],
        ),
      );
    } catch (error) {
      console.error("Failed to load available jobs", error);
      setAvailableJobs([]);
    }
  }

  async function loadAvailableWorkflows() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    try {
      const { documents } = await api.documents.get(spaceId, {
        type: "workflow",
        limit: 200,
      });
      setAvailableWorkflows(
        documents.map((doc) => ({
          id: doc.id,
          title: doc.properties.title
            ? propertyValueToText(doc.properties.title)
            : doc.slug,
        })),
      );
    } catch (error) {
      console.error("Failed to load workflow documents", error);
      setAvailableWorkflows([]);
    }
  }

  async function loadSchedules() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsLoadingSchedules(true);
    setScheduleError(null);
    try {
      const response = await api.workflows.listSchedules(spaceId);
      setSchedules(response.schedules || []);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setIsLoadingSchedules(false);
    }
  }

  function handleStartCreateSchedule() {
    setIsCreatingSchedule(true);
    setNewScheduleDocumentId("");
    setNewScheduleCron("");
    setNewScheduleTimezone("");
    setScheduleError(null);
  }

  async function handleCreateSchedule() {
    const spaceId = currentSpace()?.id;
    if (!spaceId || !newScheduleDocumentId() || !newScheduleCron().trim()) return;
    setIsSubmittingSchedule(true);
    setScheduleError(null);
    try {
      await api.workflows.createSchedule(spaceId, {
        documentId: newScheduleDocumentId(),
        cronExpression: newScheduleCron().trim(),
        ...(newScheduleTimezone().trim()
          ? { timezone: newScheduleTimezone().trim() }
          : {}),
      });
      setIsCreatingSchedule(false);
      await loadSchedules();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setIsSubmittingSchedule(false);
    }
  }

  async function handleToggleSchedule(schedule: WorkflowSchedule) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setScheduleError(null);
    try {
      await api.workflows.updateSchedule(spaceId, schedule.id, {
        enabled: !schedule.enabled,
      });
      await loadSchedules();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Failed to update schedule");
    }
  }

  async function handleDeleteSchedule(scheduleId: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm("Delete this schedule? Run history is preserved.")) return;
    setScheduleError(null);
    try {
      await api.workflows.deleteSchedule(spaceId, scheduleId);
      await loadSchedules();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Failed to delete schedule");
    }
  }

  function loadAll() {
    void loadAvailableJobs();
    void loadAvailableWorkflows();
    void loadSchedules();
  }

  onMount(loadAll);

  createEffect(
    on(
      currentSpaceId,
      (id) => {
        if (id) loadAll();
      },
      { defer: true },
    ),
  );

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-semibold text-neutral-900 text-size-medium">
          Scheduled Workflows
        </h2>
        <Show when={!isCreatingSchedule()}>
          <button
            type="button"
            onClick={handleStartCreateSchedule}
            class="font-medium text-blue-600 text-size-small hover:text-blue-800"
          >
            + Add Schedule
          </button>
        </Show>
      </div>

      <Show when={scheduleError()}>
        <div class="mb-3 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
          {scheduleError()}
        </div>
      </Show>

      <Show when={isCreatingSchedule()}>
        <div class="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateSchedule();
            }}
            class="space-y-3"
          >
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label
                  for="schedule-workflow"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Workflow
                </label>
                <select
                  id="schedule-workflow"
                  value={newScheduleDocumentId()}
                  onChange={(e) => setNewScheduleDocumentId(e.currentTarget.value)}
                  required
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                >
                  <option value="" disabled>
                    {availableWorkflows().length > 0
                      ? "Select workflow"
                      : "No workflow documents available"}
                  </option>
                  <For each={availableWorkflows()}>
                    {(workflow) => <option value={workflow.id}>{workflow.title}</option>}
                  </For>
                </select>
              </div>
              <div>
                <label
                  for="schedule-cron"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Cron Expression
                </label>
                <input
                  id="schedule-cron"
                  value={newScheduleCron()}
                  onInput={(e) => setNewScheduleCron(e.currentTarget.value)}
                  type="text"
                  required
                  placeholder="e.g. 0 6 * * 1"
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 font-mono text-size-medium"
                />
                <p class="mt-0.5 text-neutral-500 text-size-small">
                  minute hour day month weekday
                </p>
              </div>
              <div>
                <label
                  for="schedule-timezone"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Timezone <span class="font-normal text-neutral-400">(optional)</span>
                </label>
                <input
                  id="schedule-timezone"
                  value={newScheduleTimezone()}
                  onInput={(e) => setNewScheduleTimezone(e.currentTarget.value)}
                  type="text"
                  placeholder="e.g. Europe/Berlin"
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                />
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsCreatingSchedule(false);
                  setScheduleError(null);
                }}
                class="px-3 py-1.5 text-neutral-600 text-size-medium hover:text-neutral-800"
              >
                Cancel
              </button>
              <Button
                type="submit"
                disabled={isSubmittingSchedule() || !newScheduleDocumentId()}
                text={isSubmittingSchedule() ? "Creating..." : "Create Schedule"}
              />
            </div>
          </form>
        </div>
      </Show>

      <Show when={isLoadingSchedules()}>
        <div class="py-6 text-center text-neutral-500 text-size-medium">
          Loading schedules...
        </div>
      </Show>
      <Show
        when={!isLoadingSchedules() && schedules().length === 0 && !isCreatingSchedule()}
      >
        <div class="py-6 text-center text-neutral-500 text-size-medium">
          No scheduled workflows
        </div>
      </Show>
      <Show when={!isLoadingSchedules() && schedules().length > 0}>
        <div class="overflow-x-auto rounded-md border border-neutral-100">
          <table class="min-w-full text-size-medium">
            <thead class="bg-neutral-50">
              <tr>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Workflow
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Schedule
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Next Run
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Last Run
                </th>
                <th class="px-4 py-2.5 text-right font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              <For each={schedules()}>
                {(schedule) => (
                  <tr class="hover:bg-neutral-50">
                    <td class="px-4 py-2.5">
                      <div class="flex items-center gap-2">
                        <span
                          class="h-2 w-2 shrink-0 rounded-full"
                          classList={{
                            "bg-green-500": schedule.enabled,
                            "bg-neutral-300": !schedule.enabled,
                          }}
                        />
                        <span class="font-medium text-neutral-900">
                          {workflowName(schedule.documentId)}
                        </span>
                      </div>
                    </td>
                    <td class="whitespace-nowrap px-4 py-2.5">
                      <code class="rounded-sm bg-neutral-100 px-1.5 py-0.5 font-mono text-size-small">
                        {schedule.cronExpression}
                      </code>
                      <Show when={schedule.timezone}>
                        <span class="ml-1 text-neutral-400 text-size-small">
                          {schedule.timezone}
                        </span>
                      </Show>
                    </td>
                    <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                      {schedule.enabled && schedule.nextRunAt
                        ? formatDateTime(schedule.nextRunAt)
                        : "—"}
                    </td>
                    <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                      {schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : "—"}
                    </td>
                    <td class="space-x-2 whitespace-nowrap px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => void handleToggleSchedule(schedule)}
                        class="text-blue-600 text-size-small hover:text-blue-800"
                      >
                        {schedule.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteSchedule(schedule.id)}
                        class="text-red-600 text-size-small hover:text-red-800"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <div class="mt-8 border-neutral-100 border-t pt-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="font-semibold text-neutral-900 text-size-medium">
            Recent Workflow Runs
          </h2>
          <button
            type="button"
            onClick={() => refreshWorkflowRuns()}
            disabled={isLoadingWorkflowRuns()}
            class="font-medium text-blue-600 text-size-small hover:text-blue-800 disabled:opacity-50"
          >
            {isLoadingWorkflowRuns() ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <Show when={workflowRunsQueryError()}>
          <div class="mb-3 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
            {workflowRunsQueryError()?.message ?? "Failed to load workflow runs"}
          </div>
        </Show>

        <Show when={isLoadingWorkflowRuns() && workflowRuns().length === 0}>
          <div class="py-6 text-center text-neutral-500 text-size-medium">
            Loading runs...
          </div>
        </Show>
        <Show when={!isLoadingWorkflowRuns() && workflowRuns().length === 0}>
          <div class="py-6 text-center text-neutral-500 text-size-medium">
            No workflow runs yet
          </div>
        </Show>
        <Show when={workflowRuns().length > 0}>
          <div class="overflow-x-auto rounded-md border border-neutral-100">
            <table class="min-w-full text-size-medium">
              <thead class="bg-neutral-50">
                <tr>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Status
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Workflow
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Started
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Finished
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-100">
                <For each={workflowRuns()}>
                  {(run) => (
                    <tr
                      class="cursor-pointer hover:bg-neutral-50"
                      onClick={() => goToWorkflowRun(run)}
                    >
                      <td class="whitespace-nowrap px-4 py-2.5">
                        <span
                          class={`rounded-sm px-1.5 py-0.5 text-size-small ${statusClasses(run.status)}`}
                        >
                          {run.status}
                        </span>
                      </td>
                      <td class="px-4 py-2.5 font-medium text-neutral-900">
                        {run.documentTitle}
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                        {run.startedAt ? formatDateTime(run.startedAt) : "—"}
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                        {run.finishedAt ? formatDateTime(run.finishedAt) : "—"}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
        <Show when={hasMoreWorkflowRuns()}>
          <div class="mt-3 flex justify-center pt-3">
            <button
              type="button"
              onClick={() => fetchNextWorkflowRunsPage()}
              disabled={isFetchingNextWorkflowRunsPage()}
              class="rounded-md border border-neutral-100 px-4 py-1.5 text-size-small hover:border-primary-300 hover:text-primary-600 disabled:opacity-50"
            >
              {isFetchingNextWorkflowRunsPage() ? "Loading…" : "Load more"}
            </button>
          </div>
        </Show>
      </div>

      <div class="mt-8 border-neutral-100 border-t pt-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="font-semibold text-neutral-900 text-size-medium">
            Recent Extension Job Runs
          </h2>
          <button
            type="button"
            onClick={() => refreshRuns()}
            disabled={isLoadingRuns()}
            class="font-medium text-blue-600 text-size-small hover:text-blue-800 disabled:opacity-50"
          >
            {isLoadingRuns() ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <Show when={runsQueryError()}>
          <div class="mb-3 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
            {runsQueryError()?.message ?? "Failed to load job runs"}
          </div>
        </Show>

        <Show when={isLoadingRuns() && runs().length === 0}>
          <div class="py-6 text-center text-neutral-500 text-size-medium">
            Loading runs...
          </div>
        </Show>
        <Show when={!isLoadingRuns() && runs().length === 0}>
          <div class="py-6 text-center text-neutral-500 text-size-medium">
            No job runs yet
          </div>
        </Show>
        <Show when={runs().length > 0}>
          <div class="overflow-x-auto rounded-md border border-neutral-100">
            <table class="min-w-full text-size-medium">
              <thead class="bg-neutral-50">
                <tr>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Status
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Job
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Trigger
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Started
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-100">
                <For each={runs()}>
                  {(run) => (
                    <>
                      <tr
                        class="hover:bg-neutral-50"
                        classList={{ "cursor-pointer": !!run.error }}
                        onClick={() => {
                          if (!run.error) return;
                          setExpandedRunId(expandedRunId() === run.id ? null : run.id);
                        }}
                      >
                        <td class="whitespace-nowrap px-4 py-2.5">
                          <span
                            class={`rounded-sm px-1.5 py-0.5 text-size-small ${statusClasses(run.status)}`}
                          >
                            {run.status}
                          </span>
                        </td>
                        <td class="px-4 py-2.5 font-medium text-neutral-900">
                          {jobName(run.jobId)}
                        </td>
                        <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                          {run.trigger}
                        </td>
                        <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                          {formatDateTime(run.startedAt ?? run.queuedAt)}
                        </td>
                        <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                          {formatDuration(run)}
                        </td>
                      </tr>
                      <Show when={expandedRunId() === run.id && run.error}>
                        <tr>
                          <td colspan="5" class="bg-red-50 px-4 py-2.5">
                            <p class="break-all font-mono text-red-700 text-size-small">
                              {run.error}
                            </p>
                          </td>
                        </tr>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
        <PagerCursor
          class="mt-3 pt-3"
          hasPrevPage={runsHasPrevPage()}
          hasNextPage={runsHasNextPage()}
          disabled={isFetchingRuns()}
          onPrev={runsPrevPage}
          onNext={runsNextPage}
        />
      </div>
    </div>
  );
}
