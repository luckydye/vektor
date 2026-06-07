import { CronExpressionParser } from "cron-parser";
import { and, eq, isNull, lte } from "drizzle-orm";
import type { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { type JobSchedule, type JobScheduleInsert, jobSchedule } from "./schema/space.ts";

type SpaceDb = Awaited<ReturnType<typeof getSpaceDb>>;

export function validateCronExpression(
  expression: string,
  timezone?: string | null,
): { valid: true } | { valid: false; message: string } {
  try {
    CronExpressionParser.parse(expression, { tz: timezone ?? undefined });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : "Invalid cron expression",
    };
  }
}

/** Next occurrence of the cron expression strictly after `from`. */
export function computeNextRunAt(
  expression: string,
  timezone?: string | null,
  from: Date = new Date(),
): Date {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: from,
    tz: timezone ?? undefined,
  });
  return interval.next().toDate();
}

export async function createJobSchedule(
  db: SpaceDb,
  params: {
    jobId: string;
    cronExpression: string;
    timezone?: string | null;
    inputs?: Record<string, unknown> | null;
    enabled?: boolean;
    createdBy: string;
  },
): Promise<JobSchedule> {
  const now = new Date();
  const enabled = params.enabled ?? true;

  const result = await db
    .insert(jobSchedule)
    .values({
      id: createId("jobSchedule"),
      jobId: params.jobId,
      cronExpression: params.cronExpression,
      timezone: params.timezone ?? null,
      inputs: params.inputs ? JSON.stringify(params.inputs) : null,
      enabled,
      nextRunAt: enabled
        ? computeNextRunAt(params.cronExpression, params.timezone, now)
        : null,
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    })
    .returning();

  if (!result[0]) {
    throw new Error("Failed to create job schedule");
  }

  return result[0];
}

export async function getJobSchedule(
  db: SpaceDb,
  id: string,
): Promise<JobSchedule | null> {
  const result = await db.select().from(jobSchedule).where(eq(jobSchedule.id, id)).get();

  return result || null;
}

export async function listJobSchedules(db: SpaceDb): Promise<JobSchedule[]> {
  return db.select().from(jobSchedule).all();
}

export async function updateJobSchedule(
  db: SpaceDb,
  id: string,
  params: {
    cronExpression?: string;
    timezone?: string | null;
    inputs?: Record<string, unknown> | null;
    enabled?: boolean;
  },
): Promise<JobSchedule> {
  const existing = await getJobSchedule(db, id);
  if (!existing) {
    throw new Error("Job schedule not found");
  }

  const updates: Partial<JobScheduleInsert> = {
    updatedAt: new Date(),
  };

  if (params.cronExpression !== undefined) {
    updates.cronExpression = params.cronExpression;
  }
  if (params.timezone !== undefined) updates.timezone = params.timezone;
  if (params.inputs !== undefined) {
    updates.inputs = params.inputs ? JSON.stringify(params.inputs) : null;
  }
  if (params.enabled !== undefined) updates.enabled = params.enabled;

  // Recompute the next fire time whenever the expression, timezone or
  // enabled state changes; disabled schedules carry no next_run_at.
  const enabled = params.enabled ?? existing.enabled;
  if (!enabled) {
    updates.nextRunAt = null;
  } else if (
    params.cronExpression !== undefined ||
    params.timezone !== undefined ||
    params.enabled !== undefined
  ) {
    updates.nextRunAt = computeNextRunAt(
      params.cronExpression ?? existing.cronExpression,
      params.timezone !== undefined ? params.timezone : existing.timezone,
    );
  }

  const result = await db
    .update(jobSchedule)
    .set(updates)
    .where(eq(jobSchedule.id, id))
    .returning();

  if (!result[0]) {
    throw new Error("Job schedule not found");
  }

  return result[0];
}

export async function deleteJobSchedule(db: SpaceDb, id: string): Promise<void> {
  await db.delete(jobSchedule).where(eq(jobSchedule.id, id));
}

/**
 * Atomically claim all due schedules: advance next_run_at past `now` and set
 * last_run_at in the same statement that selects them, so a slow job cannot
 * be picked up again by the next tick. Missed occurrences (e.g. server was
 * down) collapse into a single fire.
 */
export async function claimDueJobSchedules(
  db: SpaceDb,
  now: Date = new Date(),
): Promise<JobSchedule[]> {
  // Backfill next_run_at for enabled schedules that lost it (e.g. rows
  // written by an older version). They start firing from their next
  // occurrence rather than immediately.
  const missing = await db
    .select()
    .from(jobSchedule)
    .where(and(eq(jobSchedule.enabled, true), isNull(jobSchedule.nextRunAt)))
    .all();
  for (const schedule of missing) {
    try {
      await db
        .update(jobSchedule)
        .set({
          nextRunAt: computeNextRunAt(schedule.cronExpression, schedule.timezone, now),
        })
        .where(and(eq(jobSchedule.id, schedule.id), isNull(jobSchedule.nextRunAt)));
    } catch {
      // Invalid stored expression — leave it dormant rather than failing the tick.
    }
  }

  const due = await db
    .select()
    .from(jobSchedule)
    .where(and(eq(jobSchedule.enabled, true), lte(jobSchedule.nextRunAt, now)))
    .all();

  const claimed: JobSchedule[] = [];
  for (const schedule of due) {
    let nextRunAt: Date | null = null;
    try {
      nextRunAt = computeNextRunAt(schedule.cronExpression, schedule.timezone, now);
    } catch {
      // Invalid expression: park the schedule instead of re-firing every tick.
    }

    const result = await db
      .update(jobSchedule)
      .set({ nextRunAt, lastRunAt: now })
      .where(
        and(
          eq(jobSchedule.id, schedule.id),
          eq(jobSchedule.enabled, true),
          lte(jobSchedule.nextRunAt, now),
        ),
      )
      .returning({ id: jobSchedule.id });

    // Guarded update: only the claimer that actually advanced the row runs the job.
    if (result[0]) {
      claimed.push(schedule);
    }
  }

  return claimed;
}

export function parseJobScheduleInputs(schedule: JobSchedule): Record<string, unknown> {
  if (!schedule.inputs) return {};
  try {
    const parsed = JSON.parse(schedule.inputs) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toJobScheduleDto(schedule: JobSchedule) {
  return {
    id: schedule.id,
    jobId: schedule.jobId,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    inputs: parseJobScheduleInputs(schedule),
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    createdBy: schedule.createdBy,
  };
}
