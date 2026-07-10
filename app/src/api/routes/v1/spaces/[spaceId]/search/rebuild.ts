import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { rebuildSearchIndex } from "#db/search.ts";

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");

      await verifySpaceRole(spaceId, user.id, "owner");

      await rebuildSearchIndex(spaceId);

      return successResponse("Search embeddings rebuilt successfully");
    },
    { fallbackMessage: "Failed to rebuild search embeddings" },
  );
