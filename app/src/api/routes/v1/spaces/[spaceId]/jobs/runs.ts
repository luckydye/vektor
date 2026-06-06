/**
 * GET /api/v1/spaces/:spaceId/jobs/runs
 *
 * Lists job execution history (newest first). All runs are recorded —
 * manual, workflow nodes and cron-scheduled.
 *
 * Query: ?jobId=...&scheduleId=...&limit=50 (max 200)
 */
import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { listJobRuns, toJobRunDto } from "#db/jobRuns.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const url = new URL(context.request.url);
    const jobId = url.searchParams.get("jobId") ?? undefined;
    const scheduleId = url.searchParams.get("scheduleId") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const runs = await listJobRuns(spaceId, {
      jobId,
      scheduleId,
      limit: limit && Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });

    return jsonResponse({ runs: runs.map(toJobRunDto) });
  }, "Failed to list job runs");
