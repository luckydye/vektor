/**
 * /api/v1/spaces/:spaceId/available-runners?for=jobs|agents
 *
 * GET: the names of the runners and nodes the caller may run jobs or agents on
 */

import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { agentRunners, jobRunners } from "#runners/runners.ts";

/**
 * List where the caller can run jobs or agents
 *
 * @tag Jobs
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const kind = new URL(context.req.url).searchParams.get("for");
    if (kind !== "jobs" && kind !== "agents") {
      throw badRequestResponse('for must be "jobs" or "agents"');
    }
    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.platform,
      context.var.credentials,
      spaceId,
      Permission.VIEWER,
    );
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId)
      throw forbiddenResponse("Runs here are a user's; this job token has none");
    const scope = { spaceId, userId };
    const runners =
      kind === "jobs"
        ? await jobRunners(context.var.platform, scope)
        : await agentRunners(context.var.platform, scope);
    return jsonResponse({ runners: runners.map((runner) => runner.name) });
  }, "Failed to list runners");
