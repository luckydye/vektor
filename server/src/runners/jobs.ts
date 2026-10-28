import { JOB_RUNNER } from "#jobs/runtime/prelude.ts";
import type { JobVmRun, JobVmRunning, Platform } from "#platform/platform.ts";
import type { JobResult } from "./contract.ts";
import { jobRunners, runsOn, startRun } from "./runners.ts";

/** Same as the job VM's default. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Runs a job on a runner: the one named `node`, else the least busy the run
 * may use. The job's table answers its calls, and holds no capability that
 * touches this server's network, disk or processes, so a runner's job can
 * never make the server do those.
 */
export function runOnRunner(
  platform: Platform,
  scope: { spaceId: string; userId: string | null; node?: string },
  job: JobVmRun,
): JobVmRunning {
  let touch = () => {};
  const result = (async () => {
    if (job.signal?.aborted) throw new Error("cancelled");
    const runner = (await jobRunners(platform, scope))
      .filter((runner) => !scope.node || runner.name === scope.node)
      .sort((a, b) => runsOn(a) - runsOn(b))[0];
    if (!runner) {
      throw new Error(
        scope.node
          ? `No runner or node "${scope.node}" is available for this job.`
          : "No runner or node is available to run this job. Add a runner in the space settings, or start a node with `vektor agent serve`.",
      );
    }
    const run = startRun(runner, {
      timeoutMs: job.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      request: (runId, host) => ({
        kind: "job",
        runId,
        script: job.script,
        inputs: job.inputs,
        prelude: JOB_RUNNER,
        host,
      }),
      handle(name, args) {
        if (name === "log") {
          job.onLog(String(args[0] ?? ""));
          return null;
        }
        // Deny by default, as in the job VM: only what the job was granted.
        if (!Object.hasOwn(job.capabilities, name)) {
          throw new Error(`"${name}" is not available in this job`);
        }
        return job.capabilities[name](...(args as never[]));
      },
    });
    touch = run.touch;
    job.signal?.addEventListener("abort", run.cancel, { once: true });
    try {
      const response = (await run.result) as JobResult;
      if (response.error !== undefined) throw new Error(String(response.error));
      return response.output;
    } finally {
      job.signal?.removeEventListener("abort", run.cancel);
    }
  })();
  return { result, touch: () => touch() };
}
