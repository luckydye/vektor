import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getLocalOrigin } from "#config";
import { extractFile } from "#db/extensions.ts";
import {
  classifyJobError,
  type JobRunTrigger,
  recordJobRunFinished,
  recordJobRunQueued,
  recordJobRunStarted,
} from "#db/jobRuns.ts";
import { buildJobWrapper } from "./jobRuntime.ts";
import { createJobToken } from "./jobToken.ts";
import type { Sandbox } from "./sandbox.ts";
import { isUnsandboxedExecutionAllowed, SandboxRequiredError } from "./sandbox.ts";

/**
 * Extract a job entry file from a zip Buffer, run it as a worker thread,
 * await the parentPort response, clean up temp files, and return outputs.
 *
 * The job runs inside a generated wrapper that installs the wiki runtime
 * globals (uploadArtifact, etc.) before importing the actual job file.
 *
 * workerData passed to the job: { ...inputs, spaceId, apiUrl, jobToken }
 *
 * The job worker posts:
 *   { success: true, outputs: { ... } }  on success
 *   { success: false, error: "..." }      on failure
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CONCURRENT_JOBS = 3;

let activeJobs = 0;
const waitQueue: Array<() => void> = [];

function releaseJobSlot(): void {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = waitQueue.shift();
  if (next) {
    activeJobs += 1;
    next();
  }
}

function acquireJobSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Job cancelled"));

  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs += 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => {
      const idx = waitQueue.indexOf(start);
      if (idx >= 0) {
        waitQueue.splice(idx, 1);
      }
      reject(new Error("Job cancelled"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    waitQueue.push(start);
  });
}

export async function runJob(
  zipBuffer: Buffer,
  entryPath: string,
  inputs: Record<string, unknown>,
  spaceId: string,
  onLog?: (message: string) => void,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    initiatedByUserId?: string | null;
    jobType?: string;
    jobId?: string;
    sandbox?: Sandbox | null;
    /** How this run was initiated; persisted to the job_run table. */
    trigger?: JobRunTrigger;
    /** job_schedule id when the run was fired by the cron scheduler. */
    scheduleId?: string | null;
  },
): Promise<Record<string, unknown>> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    initiatedByUserId,
    jobId: logicalJobId,
    sandbox,
    trigger = "manual",
    scheduleId,
  } = options ?? {};

  const executionId = crypto.randomUUID();
  await recordJobRunQueued(spaceId, {
    id: executionId,
    scheduleId: scheduleId ?? null,
    jobId: logicalJobId ?? entryPath,
    trigger,
    initiatedBy: initiatedByUserId ?? null,
  });

  if (sandbox) {
    await recordJobRunStarted(spaceId, executionId);
    try {
      const outputs = await sandbox.runJob(zipBuffer, entryPath, inputs, spaceId, onLog, {
        timeoutMs,
        signal,
        initiatedByUserId,
      });
      await recordJobRunFinished(spaceId, executionId, { status: "success" });
      return outputs;
    } catch (error) {
      await recordJobRunFinished(spaceId, executionId, {
        status: classifyJobError(error),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Defense in depth: never execute job code in-process unless that has been
  // explicitly opted into. Callers normally pass a sandbox via resolveJobSandbox().
  if (!isUnsandboxedExecutionAllowed()) {
    const error = new SandboxRequiredError();
    await recordJobRunFinished(spaceId, executionId, {
      status: classifyJobError(error),
      error: error.message,
    });
    throw error;
  }

  const fileBuffer = extractFile(zipBuffer, entryPath);
  try {
    if (signal?.aborted) throw new Error("Job cancelled");
    if (!fileBuffer) throw new Error(`Job entry not found in zip: ${entryPath}`);

    await acquireJobSlot(signal);
  } catch (error) {
    await recordJobRunFinished(spaceId, executionId, {
      status: classifyJobError(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await recordJobRunStarted(spaceId, executionId);

  let jobPath: string | null = null;
  let wrapperPath: string | null = null;

  try {
    const outputs = await (async () => {
      jobPath = join(tmpdir(), `wiki-job-${executionId}.mjs`);
      wrapperPath = join(tmpdir(), `wiki-wrapper-${executionId}.mjs`);

      await writeFile(jobPath, fileBuffer);
      await writeFile(wrapperPath, buildJobWrapper(pathToFileURL(jobPath).href));
      if (!wrapperPath) throw new Error("Failed to create worker wrapper path");

      const timestamp = Date.now().toString();

      const workerData = {
        ...inputs,
        jobId: executionId,
        spaceId,
        // Job-side API calls must stay on internal backend origin.
        apiUrl: getLocalOrigin(),
        jobToken: createJobToken(spaceId, timestamp, initiatedByUserId ?? null),
      };
      const resolvedWrapperPath = wrapperPath;

      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const worker = new Worker(resolvedWrapperPath, { workerData });
        let settled = false;
        const abortListenerController = new AbortController();

        const cancelWorker = () => {
          if (settled) return;
          try {
            worker.postMessage({ type: "cancel" });
          } catch {
            // Worker may already be terminated; ignore.
          }
        };

        const cleanup = () => {
          clearTimeout(timer);
          abortListenerController.abort();
          worker.terminate().catch(() => {});
        };
        const settleResolve = (outputs: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(outputs);
        };
        const settleReject = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        let timer = setTimeout(() => {
          cancelWorker();
          settleReject(
            new Error(`Job timed out after ${timeoutMs / 1000}s of inactivity`),
          );
        }, timeoutMs);

        const resetTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            cancelWorker();
            settleReject(
              new Error(`Job timed out after ${timeoutMs / 1000}s of inactivity`),
            );
          }, timeoutMs);
        };

        signal?.addEventListener(
          "abort",
          () => {
            if (settled) return;
            cancelWorker();
            settleReject(new Error("Job cancelled"));
          },
          { once: true, signal: abortListenerController.signal },
        );

        worker.on(
          "message",
          (msg: {
            type?: string;
            success?: boolean;
            outputs?: Record<string, unknown>;
            error?: string;
            message?: string;
          }) => {
            if (msg.type === "log") {
              resetTimer();
              const message = msg.message ?? "";
              onLog?.(message);
            } else if (msg.type === "result") {
              if (msg.success) {
                const outputs = msg.outputs ?? {};
                settleResolve(outputs);
              } else {
                settleReject(new Error(msg.error ?? "Job failed without error message"));
              }
            }
          },
        );
        worker.once("error", (err) => {
          settleReject(err instanceof Error ? err : new Error(String(err)));
        });
        worker.once("exit", (code) => {
          if (settled) return;
          settleReject(new Error(`Worker exited unexpectedly with code ${code}`));
        });
      });
    })();
    await recordJobRunFinished(spaceId, executionId, { status: "success" });
    return outputs;
  } catch (error) {
    await recordJobRunFinished(spaceId, executionId, {
      status: classifyJobError(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    releaseJobSlot();
    await Promise.all([
      jobPath ? unlink(jobPath).catch(() => {}) : Promise.resolve(),
      wrapperPath ? unlink(wrapperPath).catch(() => {}) : Promise.resolve(),
    ]);
  }
}
