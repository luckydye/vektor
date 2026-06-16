import {
  type WorkflowVmEvent,
  workflowVmCreate,
  workflowVmDestroy,
  workflowVmRejectJob,
  workflowVmResolveJob,
  workflowVmStep,
} from "@vektor/executor";
import { getExtension, getExtensionPackage } from "../db/extensions.ts";
import { otelMetrics, withSpan } from "../observability/otel.ts";
import {
  addNode,
  appendNodeLog,
  finalizeRun,
  getRun,
  setNodeStatus,
  setRunAbort,
  setRunStatus,
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
 * The return value of the script (or last expression) becomes the run output,
 * stored on the special "_script" tracking node.
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

      addNode(runId, "_script");
      setNodeStatus(runId, "_script", {
        status: "running",
        inputs: {},
        startedAt: new Date(),
      });

      let vmId: number | null = null;

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
              event.output && typeof event.output === "object" && !Array.isArray(event.output)
                ? (event.output as Record<string, unknown>)
                : {};
            setNodeStatus(runId, "_script", {
              status: "completed",
              outputs: output,
              completedAt: new Date(),
            });
            break;
          }

          if (event.type === "error") {
            throw new Error(event.message ?? "Script error");
          }

          if (event.type === "log") {
            appendNodeLog(runId, "_script", event.message ?? "");
            continue;
          }

          if (event.type === "pending_job") {
            const { jobId, extensionId, workflowJobId, inputs } = event;
            if (!jobId || !extensionId || !workflowJobId) continue;

            const stepId = jobId;
            const stepStart = Date.now();

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

                addNode(runId, stepId);
                setNodeStatus(runId, stepId, {
                  status: "running",
                  inputs: { _extensionId: extensionId, _jobId: workflowJobId, ...jobInputs },
                  startedAt: new Date(),
                });

                if (controller.signal.aborted) throw new Error("Workflow cancelled");

                const outputs = await runJob(
                  zipBuffer,
                  jobDef.entry,
                  jobInputs,
                  spaceId,
                  (msg) => appendNodeLog(runId, stepId, msg),
                  {
                    signal: controller.signal,
                    initiatedByUserId: run.initiatedByUserId,
                    jobType: "workflow_node",
                    jobId: workflowJobId,
                    trigger: "workflow",
                    sandbox,
                  },
                );

                setNodeStatus(runId, stepId, {
                  status: "completed",
                  outputs,
                  completedAt: new Date(),
                });

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
                setNodeStatus(runId, stepId, {
                  status: "failed",
                  error,
                  completedAt: new Date(),
                });
                workflowRunDurationMs.record(Date.now() - stepStart, { status: "failed" });
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
            continue;
          }
        }

        finalizeRun(runId);
        workflowRunsCounter.add(1, { status: "completed" });
        workflowRunDurationMs.record(Date.now() - workflowStart, { status: "completed" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        setNodeStatus(runId, "_script", {
          status: "failed",
          error,
          completedAt: new Date(),
        });
        setRunStatus(runId, "failed");
        finalizeRun(runId);
        workflowRunsCounter.add(1, { status: "failed" });
        workflowRunDurationMs.record(Date.now() - workflowStart, { status: "failed" });
      } finally {
        if (vmId !== null) workflowVmDestroy(vmId);
        await sandbox?.destroy();
      }
    },
  );
}
