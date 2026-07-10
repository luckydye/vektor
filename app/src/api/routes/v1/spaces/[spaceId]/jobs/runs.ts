/**
 * GET /api/v1/spaces/:spaceId/jobs/runs
 *
 * Lists job execution history (newest first). All runs are recorded —
 * manual, workflow nodes and cron-scheduled.
 *
 * Query: ?jobId=...&scheduleId=...&limit=50&offset=0 (max 500)
 */
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { listJobRuns, toJobRunDto } from "#db/jobRuns.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const { limit, offset } = parsePaginationParams(new URL(context.req.url).searchParams);
    const jobId = new URL(context.req.url).searchParams.get("jobId") ?? undefined;
    const scheduleId = new URL(context.req.url).searchParams.get("scheduleId") ?? undefined;

    const { runs, total } = await listJobRuns(spaceId, {
      jobId,
      scheduleId,
      limit,
      offset,
    });

    return jsonResponse({ runs: runs.map(toJobRunDto), total, limit, offset });
  }, "Failed to list job runs");
