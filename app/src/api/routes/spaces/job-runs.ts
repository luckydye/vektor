/**
 * GET /api/v1/spaces/:spaceId/jobs/runs
 *
 * Lists job execution history (newest first). All runs are recorded —
 * manual, workflow nodes and cron-scheduled.
 *
 * Query: ?jobId=...&scheduleId=...&limit=50&cursor=... (max 500)
 */

import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { listJobRuns, toJobRunDto } from "#db/jobRuns.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, Permission.VIEWER);

    const { limit, cursor } = parsePaginationParams(
      new URL(context.req.url).searchParams,
    );
    const jobId = new URL(context.req.url).searchParams.get("jobId") ?? undefined;
    const scheduleId =
      new URL(context.req.url).searchParams.get("scheduleId") ?? undefined;

    const { runs, nextCursor } = await listJobRuns(spaceId, {
      jobId,
      scheduleId,
      limit,
      cursor,
    });

    return jsonResponse({ runs: runs.map(toJobRunDto), limit, nextCursor });
  }, "Failed to list job runs");
