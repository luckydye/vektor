import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { jobRun, type JobRun, type JobRunInsert } from "./schema/space.ts";
import { getSpaceDb } from "./db.ts";
import { appLogger } from "../observability/logger.ts";

export type JobRunTrigger = "cron" | "manual" | "workflow";

export type JobRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "timeout";

/**
 * Recording is best-effort: a failed bookkeeping write must never fail the
 * job itself, so every helper swallows and logs its own errors.
 *
 * Only run metadata is persisted — job inputs and outputs deliberately stay
 * out of the database.
 */
export async function recordJobRunQueued(
  spaceId: string,
  params: {
    id: string;
    scheduleId?: string | null;
    jobId: string;
    trigger: JobRunTrigger;
    initiatedBy?: string | null;
  },
): Promise<void> {
  try {
    const db = await getSpaceDb(spaceId);
    await db.insert(jobRun).values({
      id: params.id,
      scheduleId: params.scheduleId ?? null,
      jobId: params.jobId,
      trigger: params.trigger,
      status: "queued",
      queuedAt: new Date(),
      initiatedBy: params.initiatedBy ?? null,
    });
  } catch (error) {
    appLogger.warn("Failed to record job run", { spaceId, runId: params.id, error });
  }
}

export async function recordJobRunStarted(spaceId: string, runId: string): Promise<void> {
  try {
    const db = await getSpaceDb(spaceId);
    await db
      .update(jobRun)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobRun.id, runId));
  } catch (error) {
    appLogger.warn("Failed to update job run", { spaceId, runId, error });
  }
}

export async function recordJobRunFinished(
  spaceId: string,
  runId: string,
  result:
    | { status: "success" }
    | { status: "failed" | "cancelled" | "timeout"; error: string },
): Promise<void> {
  try {
    const db = await getSpaceDb(spaceId);
    const updates: Partial<JobRunInsert> = {
      status: result.status,
      finishedAt: new Date(),
    };
    if (result.status !== "success") {
      updates.error = result.error;
    }
    await db.update(jobRun).set(updates).where(eq(jobRun.id, runId));
  } catch (error) {
    appLogger.warn("Failed to finalize job run", { spaceId, runId, error });
  }
}

export function classifyJobError(error: unknown): "failed" | "cancelled" | "timeout" {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("cancelled")) return "cancelled";
  if (message.includes("timed out")) return "timeout";
  return "failed";
}

/**
 * Mark runs that were queued/running when the server died as failed.
 * Only touches rows queued before `cutoff` so runs started by the freshly
 * booted server are never clobbered.
 */
export async function failStaleJobRuns(spaceId: string, cutoff: Date): Promise<number> {
  try {
    const db = await getSpaceDb(spaceId);
    const result = await db
      .update(jobRun)
      .set({ status: "failed", error: "Server restarted", finishedAt: new Date() })
      .where(
        and(inArray(jobRun.status, ["queued", "running"]), lt(jobRun.queuedAt, cutoff)),
      )
      .returning({ id: jobRun.id });
    return result.length;
  } catch (error) {
    appLogger.warn("Failed to clean up stale job runs", { spaceId, error });
    return 0;
  }
}

export async function listJobRuns(
  spaceId: string,
  options?: { jobId?: string; scheduleId?: string; limit?: number },
): Promise<JobRun[]> {
  const db = await getSpaceDb(spaceId);
  const conditions = [];
  if (options?.jobId) conditions.push(eq(jobRun.jobId, options.jobId));
  if (options?.scheduleId) conditions.push(eq(jobRun.scheduleId, options.scheduleId));

  return db
    .select()
    .from(jobRun)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(jobRun.queuedAt))
    .limit(Math.min(options?.limit ?? 50, 200))
    .all();
}

export function toJobRunDto(run: JobRun) {
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    jobId: run.jobId,
    trigger: run.trigger,
    status: run.status,
    error: run.error,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    initiatedBy: run.initiatedBy,
  };
}
