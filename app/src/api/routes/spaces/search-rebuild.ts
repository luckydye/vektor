import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { rebuildSearchIndex } from "#search/indexing.ts";

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");

      await verifySpaceRole(spaceId, user.id, Permission.OWNER);

      const store = await openSpaceStore(spaceId);
      await rebuildSearchIndex(store);

      return successResponse("Search embeddings rebuilt successfully");
    },
    { fallbackMessage: "Failed to rebuild search embeddings" },
  );
