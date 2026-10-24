/**
 * /api/v1/spaces/:spaceId/agent-triggers/:triggerId
 *
 * DELETE: delete one of the caller's agent triggers
 */

import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { deleteAgentSchedule } from "#db/space/agentSchedules.ts";
import { requireTriggerOwner } from "./agent-triggers.ts";

/**
 * Delete an agent trigger
 *
 * @tag AI
 * @jobToken
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const triggerId = requireParam(context.var.params, "triggerId");
    const userId = await requireTriggerOwner(context, spaceId);
    const store = await openSpaceStore(context.var.platform, spaceId);
    if (!(await deleteAgentSchedule(store, triggerId, userId))) {
      throw notFoundResponse("Agent trigger");
    }
    return jsonResponse({ success: true });
  }, "Failed to delete agent trigger");
