/**
 * Runs guest code, one job per call: in the platform's job VM (the integrated
 * runner) or on a runner (#runners/jobs.ts). The VM or runner owns execution;
 * this assembles the capabilities and turns what the guest produced into
 * stored outputs.
 */

import { isIntegratedRunnerEnabled } from "#config";
import { persistOutputBlobs } from "#jobs/outputBlobs.ts";
import { runOnRunner } from "#runners/jobs.ts";
import { createCapabilities } from "./capabilities.ts";
import type { JobExecution, JobRunContext } from "./types.ts";

/**
 * Starts `code`; `result` resolves with its outputs and rejects if the code
 * throws, the deadline passes, or `context.signal` cancels it.
 */
export function executeJob(code: string, context: JobRunContext): JobExecution {
  const { platform } = context;
  const onRunner = context.runner !== undefined || !isIntegratedRunnerEnabled();

  /**
   * Where `output(...)` lands.
   *
   * There are two ways for code to produce its result, because there are two
   * kinds of code. A workflow script is authored inline and simply returns a
   * value. An extension job is a bundled ESM file, where a top-level `return`
   * is not valid source — those call `output(...)` instead, which maps
   * directly onto the `postMessage({ type: "result", ... })` they used to end
   * with. An explicit `output(...)` wins over the return value.
   */
  let declaredOutputs: Record<string, unknown> | undefined;

  const capabilities = createCapabilities(platform, {
    spaceId: context.spaceId,
    jobId: context.jobId,
    initiatedByUserId: context.initiatedByUserId,
    attribution: context.attribution,
    onLog: context.onLog,
    signal: context.signal,
    onRunner,
    extra: {
      // Blobs are stored while the VM is still alive, so the job learns
      // here if its bytes were rejected rather than after it has finished.
      output: (async (outputs: unknown) => {
        declaredOutputs = await persistOutputBlobs(
          platform,
          context.spaceId,
          typeof outputs === "object" && outputs !== null && !Array.isArray(outputs)
            ? (outputs as Record<string, unknown>)
            : {},
        );
        return null;
      }) as never,
      ...context.extraCapabilities,
    },
  });

  const job = {
    script: code,
    inputs: context.inputs,
    capabilities: capabilities.table,
    onLog: context.onLog,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
  };
  const running = onRunner
    ? runOnRunner(
        platform,
        {
          spaceId: context.spaceId,
          userId: context.initiatedByUserId,
          runner: context.runner,
        },
        job,
      )
    : platform.jobVm.run(job);

  const result = (async () => {
    try {
      const returned = await running.result;
      return (
        declaredOutputs ??
        (await persistOutputBlobs(
          platform,
          context.spaceId,
          typeof returned === "object" && returned !== null && !Array.isArray(returned)
            ? (returned as Record<string, unknown>)
            : {},
        ))
      );
    } finally {
      await capabilities.dispose();
    }
  })();
  return { result, touch: running.touch };
}
