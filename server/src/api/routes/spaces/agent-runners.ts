/**
 * /api/v1/spaces/:spaceId/agent-runners
 *
 * GET: where the caller can run agents: its nodes, and the space's runners
 * that offer agents when it owns the space
 */

import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  forbiddenResponse,
  jsonResponse,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { listAgentRunners } from "#runners/agents.ts";

/**
 * List where the caller can run agents
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.platform,
      context.var.credentials,
      spaceId,
      Permission.VIEWER,
    );
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) throw forbiddenResponse("Agents run as a user; this job token has none");
    return jsonResponse({
      runners: await listAgentRunners(context.var.platform, { spaceId, userId }),
    });
  }, "Failed to list agent runners");
