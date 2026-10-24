import { and, desc, eq, isNotNull } from "drizzle-orm";
import { many } from "#db/client/query.ts";
import { type SpaceStore, wakeSpaceAfterCommit } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { type WorkflowSchedule, workflowSchedule } from "#db/schema/space.ts";
import { computeNextRunAt } from "./workflowSchedules.ts";

/**
 * Agent schedules are rows of the workflow schedule table that carry a prompt
 * instead of a workflow document; the cron scheduler claims and fires both.
 */
export type AgentSchedule = WorkflowSchedule & { prompt: string };

const isAgentSchedule = (schedule: WorkflowSchedule): schedule is AgentSchedule =>
  schedule.prompt !== null;

export async function createAgentSchedule(
  s: SpaceStore,
  params: {
    prompt: string;
    /** Due time of a one-shot schedule; a recurring one starts at its next occurrence. */
    runAt?: Date;
    cronExpression?: string;
    timezone?: string | null;
    createdBy: string;
  },
): Promise<AgentSchedule> {
  const now = new Date();
  const nextRunAt =
    params.runAt ??
    (params.cronExpression
      ? computeNextRunAt(params.cronExpression, params.timezone, now)
      : null);
  if (!nextRunAt) throw new Error("A schedule needs runAt or cronExpression");

  const [created] = await s.db
    .insert(workflowSchedule)
    .values({
      id: createId("workflowSchedule"),
      documentId: null,
      prompt: params.prompt,
      cronExpression: params.cronExpression ?? null,
      timezone: params.timezone ?? null,
      // Match SQLite's whole-second precision.
      nextRunAt: new Date(Math.floor(nextRunAt.getTime() / 1000) * 1000),
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    })
    .returning();
  if (!created || !isAgentSchedule(created)) {
    throw new Error("Failed to create agent schedule");
  }
  wakeSpaceAfterCommit(s);
  return created;
}

export async function listAgentSchedules(
  s: SpaceStore,
  createdBy: string,
): Promise<AgentSchedule[]> {
  const schedules = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(
        and(isNotNull(workflowSchedule.prompt), eq(workflowSchedule.createdBy, createdBy)),
      )
      .orderBy(desc(workflowSchedule.createdAt)),
  );
  return schedules.filter(isAgentSchedule);
}

/** Deletes `id` if it is an agent schedule `createdBy` owns; false when there is none. */
export async function deleteAgentSchedule(
  s: SpaceStore,
  id: string,
  createdBy: string,
): Promise<boolean> {
  const deleted = await s.db
    .delete(workflowSchedule)
    .where(
      and(
        eq(workflowSchedule.id, id),
        isNotNull(workflowSchedule.prompt),
        eq(workflowSchedule.createdBy, createdBy),
      ),
    )
    .returning({ id: workflowSchedule.id });
  return deleted.length > 0;
}
