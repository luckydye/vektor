/**
 * /api/v1/spaces/:spaceId/runners/:runnerId
 *
 * DELETE: remove a job runner
 */

import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  notFoundResponse,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { deleteSpaceRunner } from "#db/space/runners.ts";

/**
 * Remove a job runner
 *
 * @tag Jobs
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );
    const store = await openSpaceStore(context.var.platform, spaceId);
    const deleted = await deleteSpaceRunner(
      store,
      requireParam(context.var.params, "runnerId"),
    );
    if (!deleted) throw notFoundResponse("Runner");
    return successResponse();
  }, "Failed to remove runner");
