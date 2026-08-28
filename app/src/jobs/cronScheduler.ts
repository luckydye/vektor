import { listActiveSpaceIds } from "#db/auth/spaceIndex.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import type { WorkflowSchedule } from "#db/schema/space.ts";
import { failStaleJobRuns } from "#db/space/jobRuns.ts";
import {
  claimDueWorkflowSchedules,
  parseWorkflowScheduleInputs,
} from "#db/space/workflowSchedules.ts";
import { appLogger } from "#observability/logger.ts";
import { getLatestRunIdForDoc, getRunForRead } from "./runStore.ts";
import { startWorkflowRun } from "./workflowRuns.ts";

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

async function cleanupStaleRuns(cutoff: Date): Promise<void> {
  for (const spaceId of await listActiveSpaceIds()) {
    const count = await failStaleJobRuns(await openSpaceStore(spaceId), cutoff);
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
    for (const spaceId of await listActiveSpaceIds()) {
      try {
        const store = await openSpaceStore(spaceId);
        const due = await claimDueWorkflowSchedules(store, now);
        for (const schedule of due) {
          // Fire-and-forget: the overlap guard inside runScheduledWorkflow
          // prevents concurrent runs of the same workflow document.
          void runScheduledWorkflow(store, schedule);
        }
      } catch (error) {
        appLogger.error("Cron tick failed for space", { spaceId, error });
      }
    }
  } finally {
    tickInProgress = false;
  }
}

async function runScheduledWorkflow(
  store: SpaceStore,
  schedule: WorkflowSchedule,
): Promise<void> {
  const { spaceId } = store;
  appLogger.info("Firing scheduled workflow", {
    spaceId,
    scheduleId: schedule.id,
    documentId: schedule.documentId,
  });

  try {
    // Overlap guard: a slow-running workflow shouldn't stack concurrent runs
    // from later ticks — skip this fire if the last run hasn't finished.
    const latestRunId = await getLatestRunIdForDoc(store, schedule.documentId);
    if (latestRunId) {
      const latestRun = await getRunForRead(store, latestRunId);
      if (
        latestRun &&
        (latestRun.status === "pending" || latestRun.status === "running")
      ) {
        appLogger.warn(
          "Skipping scheduled workflow run — previous run still in progress",
          {
            spaceId,
            scheduleId: schedule.id,
            documentId: schedule.documentId,
            runId: latestRunId,
          },
        );
        return;
      }
    }

    await startWorkflowRun(store, schedule.documentId, {
      initiatedByUserId: schedule.createdBy,
      sourceExtensionId: null,
      runtimeInputs: parseWorkflowScheduleInputs(schedule),
    });
  } catch (error) {
    // This also catches resolution errors (missing/wrong-type document)
    // that happen before a run is created.
    appLogger.error("Scheduled workflow failed", {
      spaceId,
      scheduleId: schedule.id,
      documentId: schedule.documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
