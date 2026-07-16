import { getExtension, getExtensionPackage } from "#db/extensions.ts";
import { getNativeExec } from "#exec/native.ts";
import type { WorkflowVmEvent } from "#native/exec/index.d.ts";
import { otelMetrics, withSpan } from "#observability/otel.ts";
import {
  appendRunLog,
  finalizeRun,
  getRun,
  setRunAbort,
  setRunError,
  setRunStatus,
  writeRunLogs,
  writeRunResult,
} from "./runStore.ts";
import { resolveJobSandbox } from "./sandbox.ts";
import { runJob } from "./scheduler.ts";

const meter = otelMetrics.getMeter("wiki.workflows");
const workflowRunsCounter = meter.createCounter("wiki_workflow_runs_total");
const workflowRunDurationMs = meter.createHistogram("wiki_workflow_run_duration_ms", {
  unit: "ms",
});

/**
 * Execute a JavaScript workflow script in a Boa (native Rust) sandbox.
 *
 * The script has access to:
 *   - runJob(extensionId, jobId, inputs?) → Promise<outputs>
 *   - log(message) → void
 *   - input → runtime inputs object
 *
 * The return value of the script (or last expression) becomes a JSON result
 * artifact. Intermediate runJob values exist only while the script is running.
 */
export async function executeWorkflowScript(
  spaceId: string,
  runId: string,
  code: string,
  options?: {
    runtimeInputs?: Record<string, unknown>;
    traceparent?: string | null;
    tracestate?: string | null;
  },
): Promise<void> {
  const workflowStart = Date.now();

  await withSpan(
    "wiki.workflow.script.run",
    {
      traceparent: options?.traceparent,
      tracestate: options?.tracestate,
      attributes: {
        "wiki.space.id": spaceId,
        "wiki.workflow.run_id": runId,
      },
    },
    async () => {
      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);

      setRunStatus(runId, "running");
      const controller = new AbortController();
      setRunAbort(runId, () => controller.abort());

      const sandbox = await resolveJobSandbox();

      let vmId: number | null = null;
      const {
        workflowVmCreate,
        workflowVmDestroy,
        workflowVmRejectJob,
        workflowVmResolveJob,
        workflowVmStep,
      } = await getNativeExec();

      try {
        vmId = workflowVmCreate(code, options?.runtimeInputs ?? {});

        // Step-driven event loop: advance the VM until it's done, handling
        // log messages and runJob calls as they appear.
        for (;;) {
          if (controller.signal.aborted) {
            throw new Error("Workflow cancelled");
          }

          const event: WorkflowVmEvent = workflowVmStep(vmId);

          if (event.type === "done") {
            const output =
              event.output &&
              typeof event.output === "object" &&
              !Array.isArray(event.output)
                ? (event.output as Record<string, unknown>)
                : {};
            await writeRunResult(runId, output);
            break;
          }

          if (event.type === "error") {
            throw new Error(event.message ?? "Script error");
          }

          if (event.type === "log") {
            appendRunLog(runId, event.message ?? "");
            continue;
          }

          if (event.type === "pending_job") {
            const { jobId, extensionId, workflowJobId, inputs } = event;
            if (!jobId || !extensionId || !workflowJobId) continue;

            // Run the job asynchronously and resolve/reject the VM promise.
            // We do NOT await here — let the loop continue stepping while the job runs.
            // However, since this is a sequential script (each runJob is awaited by the JS),
            // we must await the result before the VM can proceed past the pending promise.
            (async () => {
              try {
                const ext = await getExtension(spaceId, extensionId);
                if (!ext) throw new Error(`Extension not found: ${extensionId}`);

                const jobDef = ext.manifest.jobs?.find((j) => j.id === workflowJobId);
                if (!jobDef)
                  throw new Error(
                    `Job "${workflowJobId}" not found in extension "${extensionId}"`,
                  );

                const zipBuffer = await getExtensionPackage(spaceId, extensionId);
                if (!zipBuffer)
                  throw new Error(`Extension package not found: ${extensionId}`);

                const jobInputs =
                  inputs && typeof inputs === "object" && !Array.isArray(inputs)
                    ? (inputs as Record<string, unknown>)
                    : {};

                if (controller.signal.aborted) throw new Error("Workflow cancelled");

                const outputs = await runJob(
                  zipBuffer,
                  jobDef.entry,
                  jobInputs,
                  spaceId,
                  (msg) =>
                    appendRunLog(runId, `[${extensionId}/${workflowJobId}] ${msg}`),
                  {
                    signal: controller.signal,
                    initiatedByUserId: run.initiatedByUserId,
                    jobType: "workflow_script_job",
                    jobId: workflowJobId,
                    trigger: "workflow",
                    sandbox,
                  },
                );

                // Unwrap JobOutputValue typed wrappers before passing back to the VM.
                const unwrapped: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(outputs ?? {})) {
                  const t = v as { type?: string; url?: string; value?: unknown };
                  if (t.type === "file") unwrapped[k] = t.url;
                  else if (t.type === "text") unwrapped[k] = t.value;
                  else unwrapped[k] = v;
                }

                if (vmId !== null) workflowVmResolveJob(vmId, jobId, unwrapped);
              } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                appendRunLog(runId, `[${extensionId}/${workflowJobId}] ${error}`);
                if (vmId !== null) workflowVmRejectJob(vmId, jobId, error);
              }
            })();

            // Yield to the event loop so the async job above can make progress,
            // then keep stepping the VM.
            await new Promise<void>((r) => setTimeout(r, 10));
            continue;
          }

          if (event.type === "pending") {
            // Promise is still settling — yield and retry.
            await new Promise<void>((r) => setTimeout(r, 10));
          }
        }

        await writeRunLogs(runId);
        await finalizeRun(runId);
        workflowRunsCounter.add(1, { status: "completed" });
        workflowRunDurationMs.record(Date.now() - workflowStart, { status: "completed" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        appendRunLog(runId, error);
        setRunError(runId, error);
        setRunStatus(runId, "failed");
        await writeRunLogs(runId);
        await finalizeRun(runId);
        workflowRunsCounter.add(1, { status: "failed" });
        workflowRunDurationMs.record(Date.now() - workflowStart, { status: "failed" });
      } finally {
        if (vmId !== null) {
          const id = vmId;
          vmId = null;
          workflowVmDestroy(id);
        }
        await sandbox?.destroy();
      }
    },
  );
}
