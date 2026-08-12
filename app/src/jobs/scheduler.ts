import { openSpaceStore } from "#db/client/store.ts";
import { extractFile } from "#db/space/extensions.ts";
import {
  classifyJobError,
  type JobRunTrigger,
  recordJobRunFinished,
  recordJobRunQueued,
  recordJobRunStarted,
} from "#db/space/jobRuns.ts";
import { getJobRuntime } from "./runtime/index.ts";
import type { CapabilityTable } from "./runtime/types.ts";

/**
 * Queue an extension job and run it in the job runtime.
 *
 * What is left here is bookkeeping: a concurrency gate, the `job_run` rows, and
 * unpacking the entry file from the extension zip. Execution, isolation and the
 * capability surface all belong to the runtime, which runs guest code on its own
 * thread — so this function no longer writes temp files, spawns workers, or
 * generates wrapper source.
 *
 * The job's return value is its outputs:
 *
 *   const text = await readDocument(input.documentId);
 *   return { words: { type: "text", value: String(text.split(/\s+/).length) } };
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CONCURRENT_JOBS = 5;

let activeJobs = 0;
const waitQueue: Array<() => void> = [];
let jobsQueuedTotal = 0;
let jobsSucceededTotal = 0;
let jobsFailedTotal = 0;

/** Snapshot of job queue/execution state, for `/metrics`. */
export function getJobQueueStats(): {
  active: number;
  waiting: number;
  queuedTotal: number;
  succeededTotal: number;
  failedTotal: number;
} {
  return {
    active: activeJobs,
    waiting: waitQueue.length,
    queuedTotal: jobsQueuedTotal,
    succeededTotal: jobsSucceededTotal,
    failedTotal: jobsFailedTotal,
  };
}

async function finishJobRun(
  spaceId: string,
  executionId: string,
  result: Parameters<typeof recordJobRunFinished>[2],
): Promise<void> {
  if (result.status === "success") {
    jobsSucceededTotal += 1;
  } else {
    jobsFailedTotal += 1;
  }
  await recordJobRunFinished(await openSpaceStore(spaceId), executionId, result);
}

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
    /** How this run was initiated; persisted to the job_run table. */
    trigger?: JobRunTrigger;
    /** Historical: workflow_schedule id, set when cron scheduling still fired extension jobs directly. */
    scheduleId?: string | null;
    /** Capabilities granted on top of the standard table (workflows add runJob). */
    extraCapabilities?: CapabilityTable;
  },
): Promise<Record<string, unknown>> {
  const store = await openSpaceStore(spaceId);
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    initiatedByUserId,
    jobId: logicalJobId,
    trigger = "manual",
    scheduleId,
    extraCapabilities,
  } = options ?? {};

  const executionId = crypto.randomUUID();
  jobsQueuedTotal += 1;
  await recordJobRunQueued(store, {
    id: executionId,
    scheduleId: scheduleId ?? null,
    jobId: logicalJobId ?? entryPath,
    trigger,
    initiatedBy: initiatedByUserId ?? null,
  });

  const fileBuffer = extractFile(zipBuffer, entryPath);
  try {
    if (signal?.aborted) throw new Error("Job cancelled");
    if (!fileBuffer) throw new Error(`Job entry not found in zip: ${entryPath}`);

    await acquireJobSlot(signal);
  } catch (error) {
    await finishJobRun(spaceId, executionId, {
      status: classifyJobError(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await recordJobRunStarted(store, executionId);

  try {
    const outputs = await getJobRuntime().execute(fileBuffer.toString("utf8"), {
      spaceId,
      jobId: logicalJobId ?? entryPath,
      initiatedByUserId: initiatedByUserId ?? null,
      inputs: { ...inputs, jobId: executionId, spaceId },
      onLog: (message) => onLog?.(message),
      signal,
      timeoutMs,
      extraCapabilities,
    });
    await finishJobRun(spaceId, executionId, { status: "success" });
    return outputs;
  } catch (error) {
    await finishJobRun(spaceId, executionId, {
      status: classifyJobError(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    releaseJobSlot();
  }
}
