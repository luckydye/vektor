/**
 * GET /api/v1/spaces/:spaceId/jobs/runs
 *
 * Lists job execution history (newest first). All runs are recorded —
 * manual, workflow nodes and cron-scheduled.
 *
 * Query: ?jobId=...&scheduleId=...&limit=50&cursor=... (max 500)
 */

import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  parsePaginationParams,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listJobRuns, toJobRunDto } from "#db/space/jobRuns.ts";

/**
 * List job runs
 *
 * @tag Jobs
 * @paginated
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const { limit, cursor } = parsePaginationParams(
      new URL(context.req.url).searchParams,
    );
    const jobId = new URL(context.req.url).searchParams.get("jobId") ?? undefined;
    const scheduleId =
      new URL(context.req.url).searchParams.get("scheduleId") ?? undefined;

    const store = await openSpaceStore(spaceId);
    const { runs, nextCursor } = await listJobRuns(store, {
      jobId,
      scheduleId,
      limit,
      cursor,
    });

    return jsonResponse({ runs: runs.map(toJobRunDto), limit, nextCursor });
  }, "Failed to list job runs");
