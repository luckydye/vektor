import { newQuickJSAsyncWASMModule, type QuickJSHandle } from "quickjs-emscripten";
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
import { runJob } from "./scheduler.ts";
import { resolveJobSandbox } from "./sandbox.ts";

const meter = otelMetrics.getMeter("wiki.workflows");
const workflowRunsCounter = meter.createCounter("wiki_workflow_runs_total");
const workflowRunDurationMs = meter.createHistogram("wiki_workflow_run_duration_ms", {
  unit: "ms",
});

/**
 * Execute a JavaScript workflow script in a QuickJS sandbox.
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
      let stepCounter = 0;

      // The _script node tracks top-level logs and the final return value.
      addNode(runId, "_script");
      setNodeStatus(runId, "_script", { status: "running", inputs: {}, startedAt: new Date() });

      try {
        const QuickJS = await newQuickJSAsyncWASMModule();
        const vm = QuickJS.newContext();

        try {
          // Expose log(message)
          const logFn = vm.newFunction("log", (msgHandle: QuickJSHandle) => {
            const msg = String(vm.dump(msgHandle) ?? "");
            appendNodeLog(runId, "_script", msg);
            return vm.undefined;
          });
          vm.setProp(vm.global, "log", logFn);
          logFn.dispose();

          // Expose input object
          const inputJson = JSON.stringify(options?.runtimeInputs ?? {});
          const inputResult = vm.evalCode(`(${inputJson})`);
          if (!inputResult.error) {
            vm.setProp(vm.global, "input", inputResult.value);
            inputResult.value.dispose();
          } else {
            inputResult.error.dispose();
          }

          // Expose runJob(extensionId, jobId, inputs?)
          const runJobFn = vm.newAsyncifiedFunction("runJob", async (...handles: QuickJSHandle[]) => {
            if (handles.length < 2) {
              throw new Error("runJob(extensionId, jobId, inputs?) requires at least 2 arguments");
            }

            const extensionId = String(vm.dump(handles[0]) ?? "");
            const jobId = String(vm.dump(handles[1]) ?? "");
            const inputsRaw = handles[2] ? vm.dump(handles[2]) : {};
            const inputs =
              inputsRaw && typeof inputsRaw === "object" && !Array.isArray(inputsRaw)
                ? (inputsRaw as Record<string, unknown>)
                : {};

            if (controller.signal.aborted) {
              throw new Error("Workflow cancelled");
            }

            const stepId = `step_${stepCounter++}`;

            const ext = await getExtension(spaceId, extensionId);
            if (!ext) throw new Error(`Extension not found: ${extensionId}`);

            const jobDef = ext.manifest.jobs?.find((j) => j.id === jobId);
            if (!jobDef) {
              throw new Error(`Job "${jobId}" not found in extension "${extensionId}"`);
            }

            const zipBuffer = await getExtensionPackage(spaceId, extensionId);
            if (!zipBuffer) throw new Error(`Extension package not found: ${extensionId}`);

            addNode(runId, stepId);
            setNodeStatus(runId, stepId, {
              status: "running",
              inputs: { _extensionId: extensionId, _jobId: jobId, ...inputs },
              startedAt: new Date(),
            });

            const stepStart = Date.now();
            try {
              const outputs = await runJob(
                zipBuffer,
                jobDef.entry,
                inputs,
                spaceId,
                (msg) => appendNodeLog(runId, stepId, msg),
                {
                  signal: controller.signal,
                  initiatedByUserId: run.initiatedByUserId,
                  jobType: "workflow_node",
                  jobId,
                  trigger: "workflow",
                  sandbox,
                },
              );

              setNodeStatus(runId, stepId, {
                status: "completed",
                outputs,
                completedAt: new Date(),
              });

              // Marshal outputs back to QuickJS
              const json = JSON.stringify(outputs ?? {});
              const resultHandle = vm.evalCode(`(${json})`);
              if (resultHandle.error) {
                resultHandle.error.dispose();
                return vm.newObject();
              }
              // ownership transfers to caller (QuickJS VM)
              return resultHandle.value;
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              setNodeStatus(runId, stepId, {
                status: "failed",
                error,
                completedAt: new Date(),
              });
              workflowRunDurationMs.record(Date.now() - stepStart, { status: "failed" });
              throw err;
            }
          });
          vm.setProp(vm.global, "runJob", runJobFn);
          runJobFn.dispose();

          // Wrap code so top-level await works
          const wrapped = `(async () => { ${code} })()`;
          const evalResult = await vm.evalCodeAsync(wrapped);

          if (evalResult.error) {
            const errDump = vm.dump(evalResult.error);
            evalResult.error.dispose();
            const msg =
              errDump && typeof errDump === "object"
                ? String((errDump as Record<string, unknown>).message ?? JSON.stringify(errDump))
                : String(errDump);
            throw new Error(msg);
          }

          const outputRaw = vm.dump(evalResult.value);
          evalResult.value.dispose();
          const output =
            outputRaw && typeof outputRaw === "object" && !Array.isArray(outputRaw)
              ? (outputRaw as Record<string, unknown>)
              : {};

          setNodeStatus(runId, "_script", {
            status: "completed",
            outputs: output,
            completedAt: new Date(),
          });
        } finally {
          vm.dispose();
          await sandbox?.destroy();
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
      }
    },
  );
}
