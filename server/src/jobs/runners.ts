import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { nodeRegistry } from "#agent/nodes/registry.ts";
import { config, getLocalOrigin } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { listJobRunnersWithSecrets } from "#db/space/jobRunners.ts";
import type { JobVmRun, JobVmRunning, Platform } from "#platform/platform.ts";
import { assertEgressAllowed } from "./runtime/capabilities.ts";
import { JOB_RUNNER } from "./runtime/prelude.ts";
import type { CapabilityTable } from "./runtime/types.ts";

/**
 * Jobs on runners: anything outside this server that runs job code, by one
 * contract (docs/job-runners.md). A runner accepts a {@link RunnerRequest}
 * and, while the job runs, calls capabilities by POSTing `{ name, args }` to
 * `host.url` with `host.token`; the `result` call ends the job with a
 * {@link RunnerResponse}. Every hop is a short request, so no connection has
 * to last as long as the job. The server answers from the job's table, which
 * holds no capability that touches this server's network, disk or processes,
 * so a runner's job can never make the server do those.
 *
 * Runners are the space's HTTP endpoints (space settings) and nodes
 * (`vektor agent serve`), which get the same request over their socket.
 */

export type RunnerRequest = {
  jobId: string;
  /** Guest source: a workflow script body or a bundled job; it may `await` and `return`. */
  script: string;
  /** The guest's `input`. */
  inputs: Record<string, unknown>;
  /** `JOB_RUNNER`: evaluates to `(host, extra?) => (script, input) => Promise<result>`. */
  prelude: string;
  host: { url: string; token: string };
};

/** `error` when the job failed, else what it returned. */
export type RunnerResponse = { output?: unknown; error?: string };

/**
 * Hands a request to a runner. Resolves once it is accepted, with the result
 * when the transport carries it (a node's socket), else with nothing: the
 * result then arrives as the job's `result` call.
 */
export type RunRequest = (
  request: RunnerRequest,
  signal: AbortSignal,
) => Promise<RunnerResponse | undefined>;

export type Runner = {
  /** Identifies the runner across jobs, for spreading them. */
  key: string;
  name: string;
  run: RunRequest;
};

/** Same as the job VM's default. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type RemoteJob = {
  token: string;
  runner: string;
  capabilities: CapabilityTable;
  onLog(message: string): void;
  touch(): void;
  /** Ends the job; only the first result counts, so a runner may retry it. */
  finish(response: RunnerResponse): void;
};

const remoteJobs = new Map<string, RemoteJob>();

/** Where runners call back: the public URL when set, else this process. */
function callbackOrigin() {
  return config().SITE_URL?.trim() || getLocalOrigin();
}

/** The space's HTTP runners; the server's request carries the runner's secret. */
async function httpRunners(platform: Platform, spaceId: string): Promise<Runner[]> {
  const runners = await listJobRunnersWithSecrets(
    await openSpaceStore(platform, spaceId),
  );
  return runners.map((runner) => ({
    key: `http:${spaceId}:${runner.id}`,
    name: runner.name,
    async run(request, signal) {
      const response = await platform.fetch(
        runner.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${runner.secret}`,
          },
          body: JSON.stringify(request),
          signal,
        },
        assertEgressAllowed,
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Runner "${runner.name}" answered ${response.status}: ${detail}`);
      }
      return undefined;
    },
  }));
}

function busy(runner: Runner) {
  let count = 0;
  for (const job of remoteJobs.values()) if (job.runner === runner.key) count++;
  return count;
}

/**
 * The runner a job goes to: the one named `node`, else the least busy of the
 * space's runners and the nodes its user may use.
 */
async function chooseRunner(
  platform: Platform,
  scope: { spaceId: string; userId: string | null; node?: string },
): Promise<Runner> {
  const runners = [
    ...nodeRegistry.jobRunners(scope),
    ...(await httpRunners(platform, scope.spaceId)),
  ].filter((runner) => !scope.node || runner.name === scope.node);
  const runner = runners.sort((a, b) => busy(a) - busy(b))[0];
  if (!runner) {
    throw new Error(
      scope.node
        ? `No runner or node "${scope.node}" is available for this job.`
        : "No runner or node is available to run this job. Add a runner in the space settings, or start a node with `vektor agent serve`.",
    );
  }
  return runner;
}

/**
 * Runs a job on a runner. The deadline is kept here: it is the same
 * inactivity deadline as the job VM's, renewed by every call the runner
 * makes, so a runner that goes away fails the job once it has been quiet
 * that long.
 */
export function runOnRunner(
  platform: Platform,
  scope: { spaceId: string; userId: string | null; node?: string },
  job: JobVmRun,
): JobVmRunning {
  const jobId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const controller = new AbortController();
  const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const touch = () => {
    if (done) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  };
  const cancel = () => controller.abort(new Error("cancelled"));

  const result = (async () => {
    if (job.signal?.aborted) throw new Error("cancelled");
    job.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const runner = await chooseRunner(platform, scope);
      const finished = Promise.withResolvers<RunnerResponse>();
      if (controller.signal.aborted) finished.reject(controller.signal.reason);
      controller.signal.addEventListener(
        "abort",
        () => finished.reject(controller.signal.reason),
        { once: true },
      );
      remoteJobs.set(jobId, {
        token,
        runner: runner.key,
        capabilities: job.capabilities,
        onLog: job.onLog,
        touch,
        finish: finished.resolve,
      });
      touch();
      // Not awaited: the result may come back before the runner's answer does.
      runner
        .run(
          {
            jobId,
            script: job.script,
            inputs: job.inputs,
            prelude: JOB_RUNNER,
            host: { url: `${callbackOrigin()}/api/v1/jobs/${jobId}/call`, token },
          },
          controller.signal,
        )
        .then((response) => response && finished.resolve(response), finished.reject);
      const response = await finished.promise;
      if (response.error !== undefined) throw new Error(String(response.error));
      return response.output;
    } finally {
      done = true;
      clearTimeout(timer);
      // The token dies with the job: a runner that keeps going is refused.
      remoteJobs.delete(jobId);
      job.signal?.removeEventListener("abort", cancel);
    }
  })();
  return { result, touch };
}

/**
 * Answers a runner's capability call for a running job. Null when the job is
 * not running or the token is not its own.
 */
export async function answerRunnerCall(
  jobId: string,
  token: string,
  name: string,
  args: unknown[],
): Promise<{ value: unknown } | { error: string } | null> {
  const job = remoteJobs.get(jobId);
  if (!job) return null;
  const expected = Buffer.from(job.token);
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  job.touch();
  if (name === "log") {
    job.onLog(String(args[0] ?? ""));
    return { value: null };
  }
  // Keeps a job that works quietly from passing its deadline.
  if (name === "touch") return { value: null };
  if (name === "result") {
    const response = args[0];
    if (typeof response !== "object" || response === null) {
      return { error: "result takes { output } or { error }" };
    }
    job.finish(response as RunnerResponse);
    return { value: null };
  }
  try {
    // Deny by default, as in the job VM: only what the job was granted.
    if (!Object.hasOwn(job.capabilities, name)) {
      throw new Error(`"${name}" is not available in this job`);
    }
    const value = await job.capabilities[name](...(args as never[]));
    return { value: value ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    job.touch();
  }
}
