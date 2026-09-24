import { useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import { api } from "#api/client.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  parseWorkflowInputFields,
  type WorkflowInputField,
} from "#documents/workflowInputs.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { WorkflowRunInputsDialog } from "./WorkflowRunInputsDialog.tsx";

interface Props {
  documentId: string;
  spaceId: string;
}

export function WorkflowRunButton(props: Props) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();

  const [starting, setStarting] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [latestRunId, setLatestRunId] = createSignal<string | null>(null);
  const [latestRunStatus, setLatestRunStatus] = createSignal<string | null>(null);
  const [promptFields, setPromptFields] = createSignal<WorkflowInputField[] | null>(null);
  const [promptError, setPromptError] = createSignal<string | null>(null);

  const isActiveRun = createMemo(
    () => latestRunStatus() === "running" || latestRunStatus() === "pending",
  );

  async function refreshLatestRun(documentId: string) {
    const latest = await api.workflows.getLatestRun(props.spaceId, documentId);
    if (props.documentId !== documentId) return;
    setLatestRunId(latest?.runId ?? null);
    setLatestRunStatus(latest?.status ?? null);
  }

  async function startRun(inputs: Record<string, unknown>) {
    setStarting(true);
    setPromptError(null);
    try {
      const { runId } = await api.workflows.startRun(
        props.spaceId,
        props.documentId,
        inputs,
      );
      setLatestRunId(runId);
      setLatestRunStatus("running");
      setPromptFields(null);
      const query = new URLSearchParams(
        searchParams as unknown as Record<string, string>,
      );
      query.set("run", runId);
      navigate(`?${query.toString()}`, { replace: true, scroll: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start workflow";
      if (promptFields()) setPromptError(message);
      else toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  async function requestRun() {
    setStarting(true);
    try {
      const doc = await api.document.get(props.spaceId, props.documentId, { live: true });
      const fields = parseWorkflowInputFields(doc.content ?? "");
      if (fields.length === 0) {
        await startRun({});
        return;
      }
      setPromptError(null);
      setPromptFields(fields);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start workflow");
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
      await refreshLatestRun(props.documentId);
    } finally {
      setCancelling(false);
    }
  }

  createEffect(
    on(
      () => props.documentId,
      (documentId) => {
        setLatestRunId(null);
        setLatestRunStatus(null);
        setPromptFields(null);
        setPromptError(null);
        void refreshLatestRun(documentId);

        const unsubscribe = api.subscribeToTopics(
          props.spaceId,
          [realtimeTopics.workflowRuns],
          () => void refreshLatestRun(documentId),
        );
        onCleanup(() => unsubscribe?.());
      },
    ),
  );

  return (
    <>
      <Show
        when={isActiveRun()}
        fallback={
          <Button disabled={starting()} onClick={requestRun}>
            <Icon
              class={twMerge(starting() && "animate-spin")}
              name={starting() ? "spinner" : "play-circle-filled"}
            />
            <span>{starting() ? "Starting…" : "Run workflow"}</span>
          </Button>
        }
      >
        <Button tone="danger" disabled={cancelling()} onClick={cancelRun}>
          <Icon
            class={twMerge(cancelling() && "animate-spin")}
            name={cancelling() ? "spinner" : "cancel"}
          />
          <span>{cancelling() ? "Cancelling…" : "Cancel"}</span>
        </Button>
      </Show>

      <Show when={promptFields()}>
        {(fields) => (
          <WorkflowRunInputsDialog
            fields={fields()}
            spaceId={props.spaceId}
            documentId={props.documentId}
            pending={starting()}
            error={promptError()}
            onCancel={() => setPromptFields(null)}
            onRun={(inputs) => void startRun(inputs)}
          />
        )}
      </Show>
    </>
  );
}
