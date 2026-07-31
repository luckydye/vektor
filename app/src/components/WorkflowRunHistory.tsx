import { For, Show } from "solid-js";
import { spinnerIcon } from "#assets/icons.ts";
import { formatDateTime } from "#utils/datetime.ts";
import { PagerCursor } from "./PagerCursor.tsx";

type RunSummary = {
  runId: string;
  status: string;
  createdAt: string;
  runtimeInputs: Record<string, unknown>;
};

interface Props {
  runs: RunSummary[];
  selectedRunId: string | null;
  hasPrevPage: boolean;
  hasNextPage: boolean;
  busy?: boolean;
  onSelect?: (runId: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
}

const statusBadgeClass: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-500",
  running: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400",
  completed:
    "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400",
  failed: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
  cancelled: "bg-neutral-100 text-neutral-400",
};

function runTitle(run: RunSummary): string {
  const title = run.runtimeInputs?.title;
  return typeof title === "string" && title ? title : "Untitled";
}

export function WorkflowRunHistory(props: Props) {
  return (
    <section class="min-w-0">
      <Show
        when={props.runs.length > 0 || props.hasPrevPage}
        fallback={<p class="text-neutral-400 text-size-medium">No runs yet.</p>}
      >
        <div class="space-y-1">
          <For each={props.runs}>
            {(run) => (
              <button
                type="button"
                class="flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors"
                classList={{
                  "border-primary-300 bg-primary-50": props.selectedRunId === run.runId,
                  "border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-100":
                    props.selectedRunId !== run.runId,
                }}
                aria-current={props.selectedRunId === run.runId ? "true" : undefined}
                onClick={() => props.onSelect?.(run.runId)}
              >
                <span
                  class="w-full truncate font-medium text-neutral-800 text-size-medium"
                  title={runTitle(run)}
                >
                  {runTitle(run)}
                </span>
                <span class="flex w-full items-center justify-between gap-2">
                  <span class="truncate text-neutral-400 text-size-small tabular-nums">
                    {formatDateTime(run.createdAt)}
                  </span>
                  <span
                    class={`inline-flex flex-none items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium text-[11px] capitalize ${
                      statusBadgeClass[run.status] ?? "bg-neutral-100 text-neutral-500"
                    }`}
                  >
                    <Show when={run.status === "running" || run.status === "pending"}>
                      <span
                        class="svg-icon h-2.5 w-2.5 animate-spin"
                        innerHTML={spinnerIcon}
                      />
                    </Show>
                    {run.status}
                  </span>
                </span>
              </button>
            )}
          </For>

          <PagerCursor
            alwaysVisible
            hasPrevPage={props.hasPrevPage}
            hasNextPage={props.hasNextPage}
            disabled={props.busy}
            onPrev={() => props.onPrev?.()}
            onNext={() => props.onNext?.()}
          />
        </div>
      </Show>
    </section>
  );
}
