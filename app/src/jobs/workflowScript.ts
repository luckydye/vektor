import RELEASE_ASYNC from "@jitl/quickjs-wasmfile-release-asyncify";
// @ts-expect-error -- Bun bundles .wasm imports as assets in --compile binaries
import wasmPath from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten";
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

/** Marshal a plain JS value into a QuickJS handle without using evalCode. */
function marshalToVM(vm: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return vm.newObject(); // return {} for null/undefined
  if (typeof value === "boolean") {
    // newNumber(0/1) avoids static-lifetime handle ownership issues with vm.true/vm.false
    return vm.newNumber(value ? 1 : 0);
  }
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "string") return vm.newString(value);
  if (Array.isArray(value)) {
    const arr = vm.newArray();
    value.forEach((item, i) => {
      const h = marshalToVM(vm, item);
      vm.setProp(arr, i, h);
      h.dispose();
    });
    return arr;
  }
  if (typeof value === "object") {
    const obj = vm.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const h = marshalToVM(vm, v);
      vm.setProp(obj, k, h);
      h.dispose();
    }
    return obj;
  }
  return vm.newString(String(value));
}

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
        const variant = newVariant(RELEASE_ASYNC, { wasmLocation: wasmPath });
        const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(variant);
        const vm = QuickJS.newContext();

        try {
          // Expose log(message)
          const logFn = vm.newFunction("log", (msgHandle: QuickJSHandle) => {
            const msg = String(vm.dump(msgHandle) ?? "");
            appendNodeLog(runId, "_script", msg);
          });
          vm.setProp(vm.global, "log", logFn);
          logFn.dispose();

          // Expose input object — use handle APIs, never vm.evalCode on async context
          const inputHandle = marshalToVM(vm, options?.runtimeInputs ?? {});
          vm.setProp(vm.global, "input", inputHandle);
          inputHandle.dispose();

          // Expose runJob(extensionId, jobId, inputs?)
          // Uses a deferred promise so QuickJS's await resolves naturally through
          // the microtask queue (executePendingJobs) instead of asyncify suspension.
          const runJobFn = vm.newFunction("runJob", (...handles: QuickJSHandle[]) => {
            if (handles.length < 2) {
              throw new Error("runJob(extensionId, jobId, inputs?) requires at least 2 arguments");
            }

            const stepId = `step_${stepCounter++}`;
            const extensionId = String(vm.dump(handles[0]) ?? "");
            const jobId = String(vm.dump(handles[1]) ?? "");
            const inputsRaw = handles[2] ? vm.dump(handles[2]) : {};
            const inputs =
              inputsRaw && typeof inputsRaw === "object" && !Array.isArray(inputsRaw)
                ? (inputsRaw as Record<string, unknown>)
                : {};

            const promise = vm.newPromise();

            // Run the actual job asynchronously; never await inside this callback.
            const stepStart = Date.now();
            (async () => {
              try {
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

                if (controller.signal.aborted) {
                  throw new Error("Workflow cancelled");
                }

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

                // Strip JobOutputValue typed wrappers before marshaling to QuickJS,
                // matching the same unwrapping logic in workflow.ts:168-173.
                const unwrapped: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(outputs ?? {})) {
                  const t = v as { type?: string; url?: string; value?: unknown };
                  if (t.type === "file") unwrapped[k] = t.url;
                  else if (t.type === "text") unwrapped[k] = t.value;
                  else unwrapped[k] = v;
                }

                promise.resolve(marshalToVM(vm, unwrapped));
              } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                setNodeStatus(runId, stepId, {
                  status: "failed",
                  error,
                  completedAt: new Date(),
                });
                workflowRunDurationMs.record(Date.now() - stepStart, { status: "failed" });
                promise.reject(vm.newError(error));
              }
            })();

            return promise.handle;
          });
          vm.setProp(vm.global, "runJob", runJobFn);
          runJobFn.dispose();

          // Run the user script inside an async IIFE.
          // evalCodeAsync may return a still-pending Promise handle when the
          // IIFE returns Promise.resolve(...), because the async thenable
          // unwrap needs an extra microtask pump.
          // We pump microtasks via executePendingJobs until it settles.
          const wrapped = `(async () => {\n${code}\n})()`;
          const evalResult = await vm.evalCodeAsync(wrapped);

          if (evalResult.error) {
            const errDump = vm.dump(evalResult.error) as Record<string, unknown>;
            evalResult.error.dispose();
            const name = String(errDump?.name ?? "Error");
            const message = String(errDump?.message ?? JSON.stringify(errDump));
            const location = String(errDump?.stack ?? "");
            throw new Error(`${name}: ${message}${location ? `\n${location}` : ""}`);
          }

          const handle = evalResult.value;

          // ── resolve pending Promise ──────────────────────────────────────
          let resolvedValue: QuickJSHandle;
          {
            let ps = vm.getPromiseState(handle);
            if (ps.type === "pending") {
              // evalCodeAsync returned a still-pending Promise.
              // Pump the microtask queue via executePendingJobs until the
              // promise settles. With deferred-promise runJob, the host side
              // must also get event-loop turns to resolve deferred promises,
              // so we interleave executePendingJobs with host yields.
              // The loop is indefinite; the caller's timeout / controller
              // signal provides the upper bound.
              for (;;) {
                vm.runtime.executePendingJobs();
                ps = vm.getPromiseState(handle);
                if (ps.type !== "pending") break;
                if (controller.signal.aborted) {
                  handle.dispose();
                  throw new Error("Workflow cancelled");
                }
                await new Promise((r) => setTimeout(r, 10));
              }
            }
            if (ps.type === "rejected") {
              const errDump = vm.dump(ps.error) as Record<string, unknown>;
              ps.error.dispose();
              handle.dispose();
              const name = String(errDump?.name ?? "Error");
              const message = String(errDump?.message ?? JSON.stringify(errDump));
              const location = String(errDump?.stack ?? "");
              throw new Error(`${name}: ${message}${location ? `\n${location}` : ""}`);
            }
            resolvedValue = handle;
          }

          // ── extract script output ────────────────────────────────────────
          // dump() disposes the handle when it encounters a fulfilled Promise,
          // so we unwrap via getPromiseState first to avoid double-dispose.
          const resultState = vm.getPromiseState(resolvedValue);
          const outputRaw =
            resultState.type === "fulfilled" && !resultState.notAPromise
              ? resultState.value.consume((inner) => vm.dump(inner))
              : vm.dump(resolvedValue);
          if (resolvedValue.alive) resolvedValue.dispose();

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
