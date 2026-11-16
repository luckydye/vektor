import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import type { SpaceStore } from "#db/client/store.ts";
import type { WorkflowSchedule } from "#db/schema/space.ts";
import { getLocalOrigin } from "#config";
import { createJobToken } from "#jobs/jobToken.ts";
import { agentPrompt } from "#jobs/runtime/agentCapability.ts";
import { assertTriggersEnabled } from "#db/space/propertyTriggers.ts";
import {
  claimDueWorkflowSchedules,
  nextWorkflowScheduleAt,
  parseWorkflowScheduleInputs,
} from "#db/space/workflowSchedules.ts";
import { enqueueSelfNotificationEmail } from "#notifications/enqueue.ts";
import { appLogger } from "#observability/logger.ts";
import type { SpaceWork } from "#platform/spaceWork.ts";
import { getLatestRunIdForDoc, getRunForRead } from "./runStore.ts";
import { startWorkflowRun } from "./workflowRuns.ts";

/** Fire the space's due workflow schedules; the runs themselves are bounded by runJob's semaphore. */
export const workflowScheduleWork: SpaceWork = {
  name: "workflow schedules",
  async run(store, now) {
    for (const schedule of await claimDueWorkflowSchedules(store, now)) {
      // Recurring schedules avoid overlapping runs; each one-shot property
      // trigger is independent and must run even if another is in progress.
      void runScheduledWorkflow(store, schedule);
    }
  },
  nextAt: (store) => nextWorkflowScheduleAt(store),
};

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
    if (schedule.prompt !== null) {
      await runAgentSchedule(store, schedule.prompt, schedule.createdBy);
      return;
    }
    if (schedule.reminder !== null) {
      await sendReminder(store, schedule, schedule.reminder);
      return;
    }
    const { documentId } = schedule;
    if (documentId === null) {
      throw new Error("Schedule has neither a workflow nor a prompt");
    }

    // Overlap guard: a slow-running workflow shouldn't stack concurrent runs
    // from later ticks — skip this fire if the last run hasn't finished.
    const latestRunId =
      schedule.cronExpression === null
        ? null
        : await getLatestRunIdForDoc(store, documentId);
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
            documentId,
            runId: latestRunId,
          },
        );
        return;
      }
    }

    if (schedule.sourceDocumentId) {
      await assertTriggersEnabled(store.platform, spaceId);
      await verifyAccess(
        store.platform,
        spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        schedule.createdBy,
        Permission.EDITOR,
      );
    }

    await startWorkflowRun(store, documentId, {
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

/** Emails the trigger's writer about its document, once per due time. */
async function sendReminder(
  store: SpaceStore,
  schedule: WorkflowSchedule,
  message: string,
): Promise<void> {
  const { sourceDocumentId, nextRunAt } = schedule;
  if (sourceDocumentId === null || nextRunAt === null) {
    throw new Error("Reminder schedule needs a source document and a due time");
  }
  await assertTriggersEnabled(store.platform, store.spaceId);
  await enqueueSelfNotificationEmail(store.platform, {
    spaceId: store.spaceId,
    kind: "reminder",
    // A reminder whose date moves is a new occurrence and is sent again.
    sourceId: `${schedule.id}:${nextRunAt.getTime()}`,
    documentId: sourceDocumentId,
    userId: schedule.createdBy,
    message: message || null,
  });
}

/** Gives the agent `prompt` as a new chat session of `userId`. */
async function runAgentSchedule(
  store: SpaceStore,
  prompt: string,
  userId: string,
): Promise<void> {
  const { spaceId } = store;
  await agentPrompt(prompt, {
    origin: getLocalOrigin(),
    spaceId,
    token: createJobToken(spaceId, Date.now().toString(), userId, { app: "agent" }),
    onLog: () => {},
  });
}
