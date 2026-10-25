/**
 * /api/v1/spaces/:spaceId/nodes
 *
 * GET: the caller's nodes (`vektor agent serve`), which agents and chats can run on
 */

import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { nodeRegistry } from "#agent/nodes/registry.ts";
import {
  forbiddenResponse,
  jsonResponse,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * List the caller's nodes
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
    if (!userId)
      throw forbiddenResponse("Nodes belong to a user; this job token has none");
    return jsonResponse({ nodes: await nodeRegistry.listNodes({ spaceId, userId }) });
  }, "Failed to list nodes");
