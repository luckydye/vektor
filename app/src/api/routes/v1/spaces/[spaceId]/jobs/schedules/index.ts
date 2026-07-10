/**
 * /api/v1/spaces/:spaceId/jobs/schedules
 *
 * GET:  list job schedules for the space (viewer)
 * POST: create a job schedule (editor — same role as running a job)
 *
 * Body: {
 *   jobId: string,
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
import { listExtensions } from "#db/extensions.ts";
import {
  createJobSchedule,
  listJobSchedules,
  toJobScheduleDto,
  validateCronExpression,
} from "#db/jobSchedules.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const db = await getSpaceDb(spaceId);
    const schedules = await listJobSchedules(db);

    return jsonResponse({ schedules: schedules.map(toJobScheduleDto) });
  }, "Failed to list job schedules");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "editor");

    const body = await parseJsonBody(context.req.raw);
    const { jobId, cronExpression, timezone, inputs, enabled } = body;

    if (!jobId || typeof jobId !== "string") {
      throw badRequestResponse("jobId is required and must be a string");
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

    // Validate the job exists in some extension of the space
    const extensions = await listExtensions(spaceId);
    const jobExists = extensions.some((ext) =>
      ext.manifest.jobs?.some((j) => j.id === jobId),
    );
    if (!jobExists) {
      throw badRequestResponse(`Job "${jobId}" not found`);
    }

    const db = await getSpaceDb(spaceId);
    const schedule = await createJobSchedule(db, {
      jobId,
      cronExpression,
      timezone,
      inputs: inputs as Record<string, unknown> | null | undefined,
      enabled,
      createdBy: user.id,
    });

    return jsonResponse({ schedule: toJobScheduleDto(schedule) });
  }, "Failed to create job schedule");
