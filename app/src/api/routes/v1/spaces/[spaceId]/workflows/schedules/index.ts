/**
 * /api/v1/spaces/:spaceId/workflows/schedules
 *
 * GET:  list workflow schedules for the space (editor)
 * POST: create a schedule that runs a workflow document (editor — same role
 *       as starting a workflow run)
 *
 * Body: {
 *   documentId: string,       // a document of type "workflow"
 *   cronExpression: string,   // standard 5-field cron, e.g. "0 6 * * 1"
 *   timezone?: string,        // IANA timezone
 *   inputs?: Record<string, unknown>,
 *   enabled?: boolean
 * }
 */
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getSpaceDb } from "#db/db.ts";
import { getDocument } from "#db/documents.ts";
import {
  createWorkflowSchedule,
  listWorkflowSchedules,
  toWorkflowScheduleDto,
  validateCronExpression,
} from "#db/workflowSchedules.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const db = await getSpaceDb(spaceId);
    const schedules = await listWorkflowSchedules(db);

    return jsonResponse({ schedules: schedules.map(toWorkflowScheduleDto) });
  }, "Failed to list workflow schedules");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const body = await parseJsonBody(context.req.raw);
    const { documentId, cronExpression, timezone, inputs, enabled } = body;

    if (!documentId || typeof documentId !== "string") {
      throw badRequestResponse("documentId is required and must be a string");
    }

    if (!cronExpression || typeof cronExpression !== "string") {
      throw badRequestResponse("cronExpression is required and must be a string");
    }

    if (timezone !== undefined && timezone !== null && typeof timezone !== "string") {
      throw badRequestResponse("timezone must be a string");
    }

    if (
      inputs !== undefined &&
      inputs !== null &&
      (typeof inputs !== "object" || Array.isArray(inputs))
    ) {
      throw badRequestResponse("inputs must be an object");
    }

    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw badRequestResponse("enabled must be a boolean");
    }

    const validation = validateCronExpression(cronExpression, timezone);
    if (!validation.valid) {
      throw badRequestResponse(`Invalid cron expression: ${validation.message}`);
    }

    // The schedule must target an existing workflow document.
    const doc = await getDocument(spaceId, documentId);
    if (!doc) {
      throw badRequestResponse(`Document "${documentId}" not found`);
    }
    if (doc.type !== "workflow") {
      throw badRequestResponse("Document type must be 'workflow'");
    }

    const db = await getSpaceDb(spaceId);
    const schedule = await createWorkflowSchedule(db, {
      documentId,
      cronExpression,
      timezone,
      inputs: inputs as Record<string, unknown> | null | undefined,
      enabled,
      createdBy: user.id,
    });

    return jsonResponse({ schedule: toWorkflowScheduleDto(schedule) });
  }, "Failed to create workflow schedule");
