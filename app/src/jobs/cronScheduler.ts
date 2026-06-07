import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSpaceDb } from "../db/db.ts";
import { getExtensionPackage, listExtensions } from "../db/extensions.ts";
import { failStaleJobRuns } from "../db/jobRuns.ts";
import { claimDueJobSchedules, parseJobScheduleInputs } from "../db/jobSchedules.ts";
import type { JobSchedule } from "../db/schema/space.ts";
import { appLogger } from "../observability/logger.ts";
import { resolveJobSandbox } from "./sandbox.ts";
import { runJob } from "./scheduler.ts";

const SPACES_DIR = join("./data", "spaces");
const TICK_INTERVAL_MS = 30_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

/**
 * Background loop that fires cron job schedules. Runs on the main thread —
 * each tick is a handful of indexed SQLite queries; the jobs themselves run
 * in worker threads via runJob, bounded by its concurrency semaphore.
 */
export function startCronScheduler(): void {
  if (tickTimer) return;

  const startedAt = new Date();

  // Runs left queued/running by a previous process are dead — mark them
  // failed so the history doesn't show phantom in-flight jobs.
  void cleanupStaleRuns(startedAt).then(() => tick());

  tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  tickTimer.unref?.();
  appLogger.info("Cron scheduler started", { tickIntervalMs: TICK_INTERVAL_MS });
}

export function stopCronScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function listSpaceIds(): Promise<string[]> {
  try {
    const entries = await readdir(SPACES_DIR);
    return entries
      .filter((name) => name.endsWith(".db"))
      .map((name) => name.slice(0, -".db".length));
  } catch {
    // Spaces directory does not exist yet — nothing to schedule.
    return [];
  }
}

async function cleanupStaleRuns(cutoff: Date): Promise<void> {
  for (const spaceId of await listSpaceIds()) {
    const count = await failStaleJobRuns(spaceId, cutoff);
    if (count > 0) {
      appLogger.warn("Marked stale job runs as failed after restart", {
        spaceId,
        count,
      });
    }
  }
}

async function tick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    const now = new Date();
    for (const spaceId of await listSpaceIds()) {
      try {
        const db = await getSpaceDb(spaceId);
        const due = await claimDueJobSchedules(db, now);
        for (const schedule of due) {
          // Fire-and-forget: runJob's semaphore bounds concurrency, and the
          // outcome is persisted to job_run by runJob itself.
          void runScheduledJob(spaceId, schedule);
        }
      } catch (error) {
        appLogger.error("Cron tick failed for space", { spaceId, error });
      }
    }
  } finally {
    tickInProgress = false;
  }
}

async function runScheduledJob(spaceId: string, schedule: JobSchedule): Promise<void> {
  appLogger.info("Firing scheduled job", {
    spaceId,
    scheduleId: schedule.id,
    jobId: schedule.jobId,
  });

  const sandbox = await resolveJobSandbox();

  try {
    // Resolve the job across all extensions, same as POST /jobs/run.
    const extensions = await listExtensions(spaceId);
    let extensionId: string | undefined;
    let entry: string | undefined;
    for (const ext of extensions) {
      const jobDef = ext.manifest.jobs?.find((j) => j.id === schedule.jobId);
      if (jobDef) {
        extensionId = ext.id;
        entry = jobDef.entry;
        break;
      }
    }
    if (!extensionId || !entry) {
      throw new Error(`Job "${schedule.jobId}" not found in any extension`);
    }

    const zipBuffer = await getExtensionPackage(spaceId, extensionId);
    if (!zipBuffer) {
      throw new Error(`Extension package not found for job "${schedule.jobId}"`);
    }

    await runJob(zipBuffer, entry, parseJobScheduleInputs(schedule), spaceId, undefined, {
      initiatedByUserId: schedule.createdBy,
      jobType: "scheduled_job",
      jobId: schedule.jobId,
      trigger: "cron",
      scheduleId: schedule.id,
      sandbox,
    });
  } catch (error) {
    // Job failures are persisted to job_run by runJob; this also catches
    // resolution errors (job/extension missing) that happen before runJob.
    appLogger.error("Scheduled job failed", {
      spaceId,
      scheduleId: schedule.id,
      jobId: schedule.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await sandbox?.destroy();
  }
}
