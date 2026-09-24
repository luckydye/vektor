import { parseCronExpression } from "cron-schedule";
import { and, eq, isNull, lte } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import {
  type WorkflowSchedule,
  type WorkflowScheduleInsert,
  workflowSchedule,
} from "#db/schema/space.ts";

/**
 * cron-schedule evaluates expressions in the process's local time and has no
 * timezone option, but a schedule carries an IANA zone. The two are bridged by
 * handing the library a Date whose *local* fields spell the target zone's wall
 * clock and mapping the wall clock it returns back onto a real instant.
 *
 * The one wall clock this cannot represent is one that falls in the process
 * zone's own spring-forward gap: `new Date(y, m, d, 2, 30)` under a zone that
 * skips 02:30 yields 03:30, so that occurrence lands an hour late. Running the
 * server in UTC removes the gap and with it the edge case.
 */
type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Throws `RangeError` if `timezone` is not a known IANA zone. */
function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  zoneFormatters.set(timezone, formatter);
  return formatter;
}

function wallClockIn(instant: Date, timezone: string): WallClock {
  const parts = zoneFormatter(timezone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

function localWallClock(date: Date): WallClock {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

/** A Date whose local fields read back as `wallClock`. */
function asLocalDate(wallClock: WallClock): Date {
  return new Date(
    wallClock.year,
    wallClock.month - 1,
    wallClock.day,
    wallClock.hour,
    wallClock.minute,
    wallClock.second,
  );
}

function asUtcMs(wallClock: WallClock): number {
  return Date.UTC(
    wallClock.year,
    wallClock.month - 1,
    wallClock.day,
    wallClock.hour,
    wallClock.minute,
    wallClock.second,
  );
}

/** Offset of `timezone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timezone: string): number {
  // Wall clocks are whole seconds, so the sub-second part of `instant` has to
  // come off both sides or it shows up as offset.
  return (
    asUtcMs(wallClockIn(instant, timezone)) - Math.floor(instant.getTime() / 1000) * 1000
  );
}

/** The instant at which `timezone`'s wall clock reads `wallClock`. */
function instantIn(wallClock: WallClock, timezone: string): Date {
  const utcMs = asUtcMs(wallClock);
  // The offset to subtract depends on the instant being solved for, so start
  // from the offset at the naive UTC reading and re-resolve once against the
  // candidate. Two passes settle every zone whose DST shift is under a day.
  const candidate = utcMs - zoneOffsetMs(new Date(utcMs), timezone);
  return new Date(utcMs - zoneOffsetMs(new Date(candidate), timezone));
}

export function validateCronExpression(
  expression: string,
  timezone?: string | null,
): { valid: true } | { valid: false; message: string } {
  try {
    parseCronExpression(expression);
    if (timezone) zoneFormatter(timezone);
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
  const cron = parseCronExpression(expression);
  if (!timezone) return cron.getNextDate(from);
  const next = cron.getNextDate(asLocalDate(wallClockIn(from, timezone)));
  return instantIn(localWallClock(next), timezone);
}

export async function createWorkflowSchedule(
  s: SpaceStore,
  params: {
    documentId: string;
    cronExpression: string;
    timezone?: string | null;
    inputs?: Record<string, unknown> | null;
    enabled?: boolean;
    createdBy: string;
  },
): Promise<WorkflowSchedule> {
  const now = new Date();
  const enabled = params.enabled ?? true;

  const result = await s.db
    .insert(workflowSchedule)
    .values({
      id: createId("workflowSchedule"),
      documentId: params.documentId,
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
    throw new Error("Failed to create workflow schedule");
  }

  return result[0];
}

export async function getWorkflowSchedule(
  s: SpaceStore,
  id: string,
): Promise<WorkflowSchedule | null> {
  const result = await one(
    s.db.select().from(workflowSchedule).where(eq(workflowSchedule.id, id)),
  );

  return result || null;
}

export async function listWorkflowSchedules(s: SpaceStore): Promise<WorkflowSchedule[]> {
  return many(s.db.select().from(workflowSchedule));
}

export async function updateWorkflowSchedule(
  s: SpaceStore,
  id: string,
  params: {
    cronExpression?: string;
    timezone?: string | null;
    inputs?: Record<string, unknown> | null;
    enabled?: boolean;
  },
): Promise<WorkflowSchedule> {
  const existing = await getWorkflowSchedule(s, id);
  if (!existing) {
    throw new Error("Workflow schedule not found");
  }

  const updates: Partial<WorkflowScheduleInsert> = {
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

  const result = await s.db
    .update(workflowSchedule)
    .set(updates)
    .where(eq(workflowSchedule.id, id))
    .returning();

  if (!result[0]) {
    throw new Error("Workflow schedule not found");
  }

  return result[0];
}

export async function deleteWorkflowSchedule(s: SpaceStore, id: string): Promise<void> {
  await s.db.delete(workflowSchedule).where(eq(workflowSchedule.id, id));
}

/**
 * Atomically claim all due schedules: advance next_run_at past `now` and set
 * last_run_at in the same statement that selects them, so a slow run cannot
 * be picked up again by the next tick. Missed occurrences (e.g. server was
 * down) collapse into a single fire.
 */
export async function claimDueWorkflowSchedules(
  s: SpaceStore,
  now: Date = new Date(),
): Promise<WorkflowSchedule[]> {
  // Backfill next_run_at for enabled schedules that lost it (e.g. rows
  // written by an older version). They start firing from their next
  // occurrence rather than immediately.
  const missing = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(and(eq(workflowSchedule.enabled, true), isNull(workflowSchedule.nextRunAt))),
  );
  for (const schedule of missing) {
    try {
      await s.db
        .update(workflowSchedule)
        .set({
          nextRunAt: computeNextRunAt(schedule.cronExpression, schedule.timezone, now),
        })
        .where(
          and(eq(workflowSchedule.id, schedule.id), isNull(workflowSchedule.nextRunAt)),
        );
    } catch {
      // Invalid stored expression — leave it dormant rather than failing the tick.
    }
  }

  const due = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(
        and(eq(workflowSchedule.enabled, true), lte(workflowSchedule.nextRunAt, now)),
      ),
  );

  const claimed: WorkflowSchedule[] = [];
  for (const schedule of due) {
    let nextRunAt: Date | null = null;
    try {
      nextRunAt = computeNextRunAt(schedule.cronExpression, schedule.timezone, now);
    } catch {
      // Invalid expression: park the schedule instead of re-firing every tick.
    }

    const result = await s.db
      .update(workflowSchedule)
      .set({ nextRunAt, lastRunAt: now })
      .where(
        and(
          eq(workflowSchedule.id, schedule.id),
          eq(workflowSchedule.enabled, true),
          lte(workflowSchedule.nextRunAt, now),
        ),
      )
      .returning({ id: workflowSchedule.id });

    // Guarded update: only the claimer that actually advanced the row runs the workflow.
    if (result[0]) {
      claimed.push(schedule);
    }
  }

  return claimed;
}

export function parseWorkflowScheduleInputs(
  schedule: WorkflowSchedule,
): Record<string, unknown> {
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

export function toWorkflowScheduleDto(schedule: WorkflowSchedule) {
  return {
    id: schedule.id,
    documentId: schedule.documentId,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    inputs: parseWorkflowScheduleInputs(schedule),
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    createdBy: schedule.createdBy,
  };
}
