import { openSpaceStore } from "#db/client/store.ts";
import { getExtension, getExtensionPackage } from "#db/space/extensions.ts";
import type { Platform } from "#platform/platform.ts";
import {
  appendRunLog,
  drainRunLogs,
  finalizeRun,
  getRun,
  setRunAbort,
  setRunError,
  setRunStatus,
  writeRunResult,
} from "./runStore.ts";
import { executeJob } from "./runtime/execute.ts";
import { runJob } from "./scheduler.ts";
import {
  createStepCacheWriter,
  stepCacheKey,
  type WorkflowStepCache,
  writeRunResumeState,
} from "./workflowStepCache.ts";

/**
 * Execute a JavaScript workflow script.
 *
 * A workflow is just a job with one extra capability: `runJob(extensionId,
 * jobId, inputs?)`, which runs an extension job and resolves with its outputs.
 * Everything else — `log`, `fetch`, the document helpers, the deadline, the
 * thread it runs on — comes from the shared runtime, so there is no separate
 * workflow execution path to keep in step.
 *
 * The script's return value becomes a JSON result artifact. Intermediate
 * `runJob` values exist only while the script is running, except that successful
 * ones are recorded so a retry can resume past completed steps.
 */
export async function executeWorkflowScript(
  platform: Platform,
  spaceId: string,
  runId: string,
  code: string,
  options?: {
    runtimeInputs?: Record<string, unknown>;
    /**
     * Seed cache from a prior run. `runJob` calls whose (extension, job,
     * inputs) match an entry replay the cached output instead of executing,
     * letting a retry resume past already-completed steps. Empty for fresh
     * runs, which then behave exactly as before.
     */
    seedCache?: WorkflowStepCache;
    /** The runner the script and the jobs it runs run on; see `JobRunContext.runner`. */
    runner?: string;
  },
): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const attribution = { app: run.sourceExtensionId ?? "workflow" };

  setRunStatus(platform, runId, "running");
  const controller = new AbortController();
  setRunAbort(runId, () => controller.abort());

  // Read-only cache from the run we're resuming; never mutated. The writer
  // accumulates every successful runJob output this run (including replayed seed
  // hits, so a chain of retries keeps resuming) under a size budget.
  const seedCache = options?.seedCache ?? {};
  const runtimeInputs = options?.runtimeInputs ?? {};
  const stepCache = createStepCacheWriter(seedCache);
  let touchWorkflowVm: (() => void) | undefined;

  // Nested jobs report to the workflow log directly, rather than through the
  // parent VM. Forward that activity to the parent so its inactivity deadline
  // reflects progress anywhere in the workflow tree.
  const appendWorkflowLog = (message: string, level?: "info" | "error"): void => {
    appendRunLog(platform, runId, message, level);
    touchWorkflowVm?.();
  };

  // Persist the exact inputs up front so a retry reproduces the script's `input`
  // faithfully — the copy on the run document is summarized for display and is
  // not safe to resume from.
  const persistResumeState = async () => {
    const dropped = stepCache.droppedSteps();
    if (dropped > 0) {
      appendWorkflowLog(
        `resume: ${dropped} step result(s) exceeded the cache budget and will re-run on retry`,
      );
    }
    await writeRunResumeState(platform, spaceId, runId, {
      inputs: runtimeInputs,
      steps: stepCache.snapshot(),
    });
  };
  await persistResumeState();

  /**
   * The `runJob` capability. Resolving with the job's outputs (or throwing) is
   * all the workflow script sees; the VM turns that into the awaited promise.
   */
  const runWorkflowJob = async (
    rawExtensionId: unknown,
    rawJobId: unknown,
    rawInputs: unknown,
  ): Promise<Record<string, unknown>> => {
    const extensionId = String(rawExtensionId ?? "");
    const workflowJobId = String(rawJobId ?? "");
    if (!extensionId || !workflowJobId) {
      throw new Error(
        "runJob(extensionId, jobId, inputs?) requires an extension and job id",
      );
    }
    const jobInputs =
      typeof rawInputs === "object" && rawInputs !== null && !Array.isArray(rawInputs)
        ? (rawInputs as Record<string, unknown>)
        : {};

    const cacheKey = stepCacheKey(extensionId, workflowJobId, jobInputs);

    // Resume: replay a prior run's successful output without re-executing.
    const cached = seedCache[cacheKey];
    if (cached) {
      appendWorkflowLog(
        `[${extensionId}/${workflowJobId}] resume: replayed cached result (skipped)`,
      );
      return cached;
    }

    const extension = await getExtension(
      await openSpaceStore(platform, spaceId),
      extensionId,
    );
    if (!extension) throw new Error(`Extension not found: ${extensionId}`);

    const jobDef = extension.manifest.jobs?.find((j) => j.id === workflowJobId);
    if (!jobDef) {
      const available = extension.manifest.jobs?.map((j) => j.id).join(", ") || "none";
      throw new Error(
        `Job "${workflowJobId}" not found in extension "${extensionId}" (jobs: ${available})`,
      );
    }

    const zipBuffer = await getExtensionPackage(
      await openSpaceStore(platform, spaceId),
      extensionId,
    );
    if (!zipBuffer) throw new Error(`Extension package not found: ${extensionId}`);

    if (controller.signal.aborted) throw new Error("Workflow cancelled");

    const outputs = await runJob(
      platform,
      zipBuffer,
      jobDef.entry,
      jobInputs,
      spaceId,
      (message) => appendWorkflowLog(`[${extensionId}/${workflowJobId}] ${message}`),
      {
        signal: controller.signal,
        initiatedByUserId: run.initiatedByUserId,
        attribution,
        jobId: workflowJobId,
        runner: options?.runner,
      },
    );

    // Unwrap JobOutputValue typed wrappers before handing values to the script.
    const unwrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(outputs ?? {})) {
      const typed = value as { type?: string; url?: string; value?: unknown };
      if (typed.type === "file" || typed.type === "blob") unwrapped[key] = typed.url;
      else if (typed.type === "text") unwrapped[key] = typed.value;
      else unwrapped[key] = value;
    }

    stepCache.record(cacheKey, unwrapped);
    return unwrapped;
  };

  try {
    const execution = executeJob(code, {
      platform,
      spaceId,
      jobId: `workflow:${runId}`,
      initiatedByUserId: run.initiatedByUserId,
      attribution,
      inputs: runtimeInputs,
      runner: options?.runner,
      onLog: appendWorkflowLog,
      signal: controller.signal,
      extraCapabilities: { runJob: runWorkflowJob as never },
    });
    touchWorkflowVm = execution.touch;
    const output = await execution.result;

    await writeRunResult(platform, runId, output);
    await persistResumeState();
    await finalizeRun(platform, runId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendWorkflowLog(error, "error");
    await drainRunLogs(platform, runId);
    setRunError(platform, runId, error);
    setRunStatus(platform, runId, "failed");
    // Persist whatever completed so a retry can resume past these steps. This
    // also covers cancellation, which reaches us as an abort error.
    await persistResumeState();
    await finalizeRun(platform, runId);
  }
}
