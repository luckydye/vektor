/**
 * /api/v1/spaces/:spaceId/workflows/schedules/:scheduleId
 *
 * GET:    fetch a workflow schedule (editor)
 * PATCH:  update cronExpression/timezone/inputs/enabled (editor)
 * DELETE: remove the schedule (editor); run history is preserved
 */
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getSpaceDb } from "#db/db.ts";
import {
  deleteWorkflowSchedule,
  getWorkflowSchedule,
  toWorkflowScheduleDto,
  updateWorkflowSchedule,
  validateCronExpression,
} from "#db/workflowSchedules.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const scheduleId = requireParam(context.var.params, "scheduleId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const db = await getSpaceDb(spaceId);
    const schedule = await getWorkflowSchedule(db, scheduleId);

    if (!schedule) {
      throw notFoundResponse("Workflow schedule");
    }

    return jsonResponse({ schedule: toWorkflowScheduleDto(schedule) });
  }, "Failed to get workflow schedule");

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const scheduleId = requireParam(context.var.params, "scheduleId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const db = await getSpaceDb(spaceId);
    const existing = await getWorkflowSchedule(db, scheduleId);

    if (!existing) {
      throw notFoundResponse("Workflow schedule");
    }

    const body = await parseJsonBody(context.req.raw);
    const { cronExpression, timezone, inputs, enabled } = body;

    if (cronExpression !== undefined && typeof cronExpression !== "string") {
      throw badRequestResponse("cronExpression must be a string");
    }

    if (timezone !== undefined && timezone !== null && typeof timezone !== "string") {
      throw badRequestResponse("timezone must be a string or null");
    }

    if (
      inputs !== undefined &&
      inputs !== null &&
      (typeof inputs !== "object" || Array.isArray(inputs))
    ) {
      throw badRequestResponse("inputs must be an object or null");
    }

    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw badRequestResponse("enabled must be a boolean");
    }

    if (cronExpression !== undefined || timezone !== undefined) {
      const validation = validateCronExpression(
        cronExpression ?? existing.cronExpression,
        timezone !== undefined ? timezone : existing.timezone,
      );
      if (!validation.valid) {
        throw badRequestResponse(`Invalid cron expression: ${validation.message}`);
      }
    }

    const schedule = await updateWorkflowSchedule(db, scheduleId, {
      cronExpression,
      timezone,
      inputs: inputs as Record<string, unknown> | null | undefined,
      enabled,
    });

    return jsonResponse({ schedule: toWorkflowScheduleDto(schedule) });
  }, "Failed to update workflow schedule");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const scheduleId = requireParam(context.var.params, "scheduleId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const db = await getSpaceDb(spaceId);
    const schedule = await getWorkflowSchedule(db, scheduleId);

    if (!schedule) {
      throw notFoundResponse("Workflow schedule");
    }

    await deleteWorkflowSchedule(db, scheduleId);

    return jsonResponse({ success: true });
  }, "Failed to delete workflow schedule");
