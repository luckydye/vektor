/**
 * Runs guest code in the platform's job VM, or on a runner, one job per call.
 * The VM owns execution, timeouts and the host-call protocol; this assembles
 * the capabilities and turns what the guest produced into stored outputs.
 */

import { config } from "#config";
import { persistOutputBlobs } from "#jobs/outputBlobs.ts";
import { runOnRunner } from "#runners/jobs.ts";
import { createCapabilities } from "./capabilities.ts";
import type { JobExecution, JobRunContext, JobRuntime } from "./types.ts";

export function createVmRuntime(): JobRuntime {
  return {
    name: "vm",

    execute(code: string, context: JobRunContext): JobExecution {
      const { platform } = context;
      const remote = context.node !== undefined || config().JOB_RUNTIME === "runners";

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
        remote,
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
      const running = remote
        ? runOnRunner(
            platform,
            {
              spaceId: context.spaceId,
              userId: context.initiatedByUserId,
              node: context.node,
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
              typeof returned === "object" &&
                returned !== null &&
                !Array.isArray(returned)
                ? (returned as Record<string, unknown>)
                : {},
            ))
          );
        } finally {
          await capabilities.dispose();
        }
      })();
      return { result, touch: running.touch };
    },
  };
}
