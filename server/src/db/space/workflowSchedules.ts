import { parseCronExpression } from "cron-schedule";
import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import { type SpaceStore, wakeSpaceAfterCommit } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import {
  type WorkflowSchedule,
  type WorkflowScheduleInsert,
  workflowSchedule,
  document,
} from "#db/schema/space.ts";
import {
  canonicalPropertyKey,
  InvalidDocumentPropertyPatchError,
} from "#documents/properties.ts";

/** A resolved property trigger; the scheduler never reads its definition. */
export interface PropertyWorkflowSchedule {
  propertyKey: string;
  workflowId: string;
  runAt: Date | null;
  /** Only an explicit trigger write changes its execution identity. */
  triggerWritten: boolean;
  changed: boolean;
}

/**
 * Reconcile a document's complete set of property-owned schedules. The caller
 * supplies the transaction that writes the properties, so both commit together.
 */
export async function syncPropertyWorkflowSchedules(
  s: SpaceStore,
  sourceDocumentId: string,
  desired: PropertyWorkflowSchedule[],
  userId: string | undefined,
): Promise<void> {
  const now = new Date();
  const existing = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(eq(workflowSchedule.sourceDocumentId, sourceDocumentId)),
  );
  const byKey = new Map(
    existing.map((entry) => [canonicalPropertyKey(entry.propertyKey ?? ""), entry]),
  );
  const desiredKeys = new Set(
    desired.map((entry) => canonicalPropertyKey(entry.propertyKey)),
  );
  for (const stale of existing) {
    if (!desiredKeys.has(canonicalPropertyKey(stale.propertyKey ?? ""))) {
      await s.db.delete(workflowSchedule).where(eq(workflowSchedule.id, stale.id));
    }
  }

  for (const entry of desired) {
    if (!entry.changed) continue;
    const current = byKey.get(canonicalPropertyKey(entry.propertyKey));
    // Match SQLite's whole-second precision, including after an occurrence fired.
    const nextRunAt = entry.runAt
      ? new Date(Math.floor(entry.runAt.getTime() / 1000) * 1000)
      : null;
    const target = await one(
      s.db
        .select({ type: document.type })
        .from(document)
        .where(eq(document.id, entry.workflowId)),
    );
    // A deleted target must not prevent edits to the source document.
    if (target?.type !== "workflow") {
      if (current) {
        await s.db.delete(workflowSchedule).where(eq(workflowSchedule.id, current.id));
      }
      continue;
    }
    const createdBy =
      current && !entry.triggerWritten ? current.createdBy : userId;
    if (!createdBy) {
      throw new InvalidDocumentPropertyPatchError(
        `Trigger "${entry.propertyKey}" needs a user to run its workflow as`,
      );
    }
    if (
      current?.documentId === entry.workflowId &&
      current.nextRunAt?.getTime() === nextRunAt?.getTime()
    ) {
      if (current.propertyKey !== entry.propertyKey && current.propertyKey !== null) {
        await renamePropertyWorkflowSchedule(
          s,
          sourceDocumentId,
          current.propertyKey,
          entry.propertyKey,
        );
      }
      // A writer change must not re-arm an occurrence that already fired.
      if (current.createdBy !== createdBy) {
        await s.db
          .update(workflowSchedule)
          .set({ createdBy, updatedAt: now })
          .where(eq(workflowSchedule.id, current.id));
      }
      continue;
    }

    const expired = entry.runAt !== null && entry.runAt <= now;
    const values = {
      propertyKey: entry.propertyKey,
      documentId: entry.workflowId,
      sourceDocumentId,
      inputs: JSON.stringify({
        documentId: sourceDocumentId,
        propertyKey: entry.propertyKey,
      }),
      cronExpression: null,
      createdBy,
      nextRunAt,
      enabled: nextRunAt !== null && !expired,
      lastRunAt: expired ? now : null,
      updatedAt: now,
    };
    if (current) {
      await s.db
        .update(workflowSchedule)
        .set(values)
        .where(eq(workflowSchedule.id, current.id));
    } else {
      await s.db
        .insert(workflowSchedule)
        .values({ id: createId("workflowSchedule"), createdAt: now, ...values });
    }
    wakeSpaceAfterCommit(s);
  }
}

/** Move a schedule's source without changing its due time or consumed state. */
export async function renamePropertyWorkflowSchedule(
  s: SpaceStore,
  sourceDocumentId: string,
  from: string,
  to: string,
): Promise<void> {
  await s.db
    .update(workflowSchedule)
    .set({
      propertyKey: to,
      inputs: JSON.stringify({ documentId: sourceDocumentId, propertyKey: to }),
    })
    .where(
      and(
        eq(workflowSchedule.sourceDocumentId, sourceDocumentId),
        eq(workflowSchedule.propertyKey, from),
      ),
    );
}

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
): Promise<WorkflowDocumentSchedule> {
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

  wakeSpaceAfterCommit(s);
  return { ...result[0], documentId: params.documentId };
}

/** A schedule that runs a workflow document, as opposed to an agent prompt. */
export type WorkflowDocumentSchedule = WorkflowSchedule & { documentId: string };

export async function getWorkflowSchedule(
  s: SpaceStore,
  id: string,
): Promise<(WorkflowDocumentSchedule & { cronExpression: string }) | null> {
  const result = await one(
    s.db.select().from(workflowSchedule).where(eq(workflowSchedule.id, id)),
  );

  // Property-owned one-shot schedules are edited through their property.
  return result?.cronExpression != null && result.documentId !== null
    ? { ...result, cronExpression: result.cronExpression, documentId: result.documentId }
    : null;
}

export async function listWorkflowSchedules(
  s: SpaceStore,
): Promise<WorkflowDocumentSchedule[]> {
  const schedules = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(
        and(
          isNotNull(workflowSchedule.cronExpression),
          isNotNull(workflowSchedule.documentId),
        ),
      ),
  );
  return schedules.filter((schedule): schedule is WorkflowDocumentSchedule =>
    schedule.documentId !== null,
  );
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
): Promise<WorkflowDocumentSchedule> {
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

  wakeSpaceAfterCommit(s);
  return { ...result[0], documentId: existing.documentId };
}

/** The earliest time an enabled schedule is due, or null when none is. */
export async function nextWorkflowScheduleAt(s: SpaceStore): Promise<Date | null> {
  const next = await one(
    s.db
      .select({ nextRunAt: workflowSchedule.nextRunAt })
      .from(workflowSchedule)
      .where(
        and(eq(workflowSchedule.enabled, true), isNotNull(workflowSchedule.nextRunAt)),
      )
      .orderBy(asc(workflowSchedule.nextRunAt))
      .limit(1),
  );
  return next?.nextRunAt ?? null;
}

export async function deleteWorkflowSchedule(s: SpaceStore, id: string): Promise<void> {
  await s.db.delete(workflowSchedule).where(
    and(
      eq(workflowSchedule.id, id),
      isNotNull(workflowSchedule.cronExpression),
      isNotNull(workflowSchedule.documentId),
    ),
  );
}

/**
 * Claim due schedules with a guarded update: advance recurring schedules,
 * disable one-shots, and record last_run_at. Missed recurring occurrences
 * (e.g. server was down) collapse into a single fire.
 */
export async function claimDueWorkflowSchedules(
  s: SpaceStore,
  now: Date = new Date(),
): Promise<WorkflowSchedule[]> {
  // Deprecated compatibility backfill for recurring schedules written without
  // next_run_at by older versions. Start at their next occurrence; never
  // backfill one-shot schedules.
  const missing = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(
        and(
          eq(workflowSchedule.enabled, true),
          isNotNull(workflowSchedule.cronExpression),
          isNull(workflowSchedule.nextRunAt),
        ),
      ),
  );
  for (const schedule of missing) {
    if (schedule.cronExpression === null) continue;
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
      // Invalid stored expression — leave it dormant rather than failing the pass.
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
    if (schedule.nextRunAt === null) continue;
    const oneShot = schedule.cronExpression === null;
    // Retain a consumed one-shot's due time to recognize unchanged property writes.
    let nextRunAt: Date | null = schedule.nextRunAt;
    if (schedule.cronExpression !== null) {
      try {
        nextRunAt = computeNextRunAt(schedule.cronExpression, schedule.timezone, now);
      } catch {
        // Invalid expression: park the schedule instead of re-firing every pass.
        nextRunAt = null;
      }
    }

    const result = await s.db
      .update(workflowSchedule)
      .set({ nextRunAt, lastRunAt: now, enabled: !oneShot })
      .where(
        and(
          eq(workflowSchedule.id, schedule.id),
          eq(workflowSchedule.enabled, true),
          eq(workflowSchedule.nextRunAt, schedule.nextRunAt),
          schedule.cronExpression === null
            ? isNull(workflowSchedule.cronExpression)
            : eq(workflowSchedule.cronExpression, schedule.cronExpression),
          schedule.timezone === null
            ? isNull(workflowSchedule.timezone)
            : eq(workflowSchedule.timezone, schedule.timezone),
        ),
      )
      .returning();

    // Timing must still match what we computed above. Execution metadata comes
    // from the claimed row, so an intervening edit cannot run a stale workflow.
    const claimedSchedule = result[0];
    if (claimedSchedule) {
      if (claimedSchedule.sourceDocumentId) {
        const source = await one(
          s.db
            .select({ archived: document.archived })
            .from(document)
            .where(eq(document.id, claimedSchedule.sourceDocumentId)),
        );
        // Consume trashed documents' triggers so restoring them cannot fire late.
        if (!source || source.archived) continue;
      }
      claimed.push(claimedSchedule);
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

export function toWorkflowScheduleDto(schedule: WorkflowDocumentSchedule) {
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
