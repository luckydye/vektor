import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { rebuildSearchIndex } from "#db/search.ts";

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");

      await verifySpaceRole(spaceId, user.id, Permission.OWNER);

      await rebuildSearchIndex(spaceId);

      return successResponse("Search embeddings rebuilt successfully");
    },
    { fallbackMessage: "Failed to rebuild search embeddings" },
  );
