import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { many } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { decodeSeekCursor, encodeSeekCursor } from "#db/cursor.ts";
import { type JobRun, type JobRunInsert, jobRun } from "#db/schema/space.ts";
import { appLogger } from "#observability/logger.ts";

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
  s: SpaceStore,
  params: {
    id: string;
    scheduleId?: string | null;
    jobId: string;
    trigger: JobRunTrigger;
    initiatedBy?: string | null;
  },
): Promise<void> {
  try {
    await s.db.insert(jobRun).values({
      id: params.id,
      scheduleId: params.scheduleId ?? null,
      jobId: params.jobId,
      trigger: params.trigger,
      status: "queued",
      queuedAt: new Date(),
      initiatedBy: params.initiatedBy ?? null,
    });
  } catch (error) {
    appLogger.warn("Failed to record job run", {
      spaceId: s.spaceId,
      runId: params.id,
      error,
    });
  }
}

export async function recordJobRunStarted(s: SpaceStore, runId: string): Promise<void> {
  try {
    await s.db
      .update(jobRun)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobRun.id, runId));
  } catch (error) {
    appLogger.warn("Failed to update job run", { spaceId: s.spaceId, runId, error });
  }
}

export async function recordJobRunFinished(
  s: SpaceStore,
  runId: string,
  result:
    | { status: "success" }
    | { status: "failed" | "cancelled" | "timeout"; error: string },
): Promise<void> {
  try {
    const updates: Partial<JobRunInsert> = {
      status: result.status,
      finishedAt: new Date(),
    };
    if (result.status !== "success") {
      updates.error = result.error;
    }
    await s.db.update(jobRun).set(updates).where(eq(jobRun.id, runId));
  } catch (error) {
    appLogger.warn("Failed to finalize job run", { spaceId: s.spaceId, runId, error });
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
export async function failStaleJobRuns(s: SpaceStore, cutoff: Date): Promise<number> {
  try {
    const result = await s.db
      .update(jobRun)
      .set({ status: "failed", error: "Server restarted", finishedAt: new Date() })
      .where(
        and(inArray(jobRun.status, ["queued", "running"]), lt(jobRun.queuedAt, cutoff)),
      )
      .returning({ id: jobRun.id });
    return result.length;
  } catch (error) {
    appLogger.warn("Failed to clean up stale job runs", { spaceId: s.spaceId, error });
    return 0;
  }
}

// Cursor encodes the (queuedAt, id) position of the last returned run.
export function encodeJobRunCursor(queuedAt: Date, id: string): string {
  return encodeSeekCursor(queuedAt.getTime(), id);
}

export function decodeJobRunCursor(
  cursor: string,
): { queuedAt: Date; id: string } | null {
  const pos = decodeSeekCursor(cursor, "string");
  if (!pos) return null;
  return { queuedAt: new Date(pos.t), id: pos.id as string };
}

export async function listJobRuns(
  s: SpaceStore,
  options?: { jobId?: string; scheduleId?: string; limit?: number; cursor?: string },
): Promise<{ runs: JobRun[]; nextCursor: string | null }> {
  const conditions = [];
  if (options?.jobId) conditions.push(eq(jobRun.jobId, options.jobId));
  if (options?.scheduleId) conditions.push(eq(jobRun.scheduleId, options.scheduleId));

  const pos = options?.cursor ? decodeJobRunCursor(options.cursor) : null;
  if (pos) {
    conditions.push(
      or(
        lt(jobRun.queuedAt, pos.queuedAt),
        and(eq(jobRun.queuedAt, pos.queuedAt), lt(jobRun.id, pos.id)),
      ),
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = options?.limit ?? 50;
  const fetchLimit = limit + 1;
  const rows = await many(
    s.db
      .select()
      .from(jobRun)
      .where(where)
      .orderBy(desc(jobRun.queuedAt), desc(jobRun.id))
      .limit(fetchLimit),
  );

  let nextCursor: string | null = null;
  let runs = rows;
  if (rows.length === fetchLimit) {
    runs = rows.slice(0, -1);
    const last = runs[runs.length - 1];
    nextCursor = last ? encodeJobRunCursor(last.queuedAt, last.id) : null;
  }
  return { runs, nextCursor };
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
