import { useNavigate, useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { api } from "#api/client.ts";
import { cancelIcon, playCircleFilledIcon, spinnerIcon } from "#assets/icons.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Button } from "./Button.tsx";

interface Props {
  documentId: string;
  spaceId: string;
}

export function WorkflowRunButton(props: Props) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [starting, setStarting] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [latestRunId, setLatestRunId] = createSignal<string | null>(null);
  const [latestRunStatus, setLatestRunStatus] = createSignal<string | null>(null);

  const isActiveRun = createMemo(
    () => latestRunStatus() === "running" || latestRunStatus() === "pending",
  );

  async function refreshLatestRun() {
    const latest = await api.workflows.getLatestRun(props.spaceId, props.documentId);
    setLatestRunId(latest?.runId ?? null);
    setLatestRunStatus(latest?.status ?? null);
  }

  async function startRun() {
    setStarting(true);
    try {
      const { runId } = await api.workflows.startRun(props.spaceId, props.documentId, {});
      setLatestRunId(runId);
      setLatestRunStatus("running");
      // The workflow view follows the `run` query param, so pointing the URL at
      // the new run switches the view over to it.
      const query = new URLSearchParams(
        searchParams as unknown as Record<string, string>,
      );
      query.set("run", runId);
      navigate(`?${query.toString()}`, { replace: true, scroll: false });
    } finally {
      setStarting(false);
    }
  }

  async function cancelRun() {
    const runId = latestRunId();
    if (!runId || cancelling()) return;
    setCancelling(true);
    try {
      await api.workflows.cancelRun(props.spaceId, runId);
      await refreshLatestRun();
    } finally {
      setCancelling(false);
    }
  }

  onMount(async () => {
    await refreshLatestRun();
    // Keep the run/cancel state in sync without polling.
    const unsubscribe = api.subscribeToTopics(
      props.spaceId,
      [realtimeTopics.workflowRuns],
      () => void refreshLatestRun(),
    );
    onCleanup(() => unsubscribe?.());
  });

  return (
    <Show
      when={isActiveRun()}
      fallback={
        <Button disabled={starting()} onClick={startRun}>
          <div
            class="icon"
            classList={{ "animate-spin": starting() }}
            innerHTML={starting() ? spinnerIcon : playCircleFilledIcon}
          />
          <span>{starting() ? "Starting…" : "Run workflow"}</span>
        </Button>
      }
    >
      <Button tone="danger" disabled={cancelling()} onClick={cancelRun}>
        <div
          class="icon"
          classList={{ "animate-spin": cancelling() }}
          innerHTML={cancelling() ? spinnerIcon : cancelIcon}
        />
        <span>{cancelling() ? "Cancelling…" : "Cancel"}</span>
      </Button>
    </Show>
  );
}
