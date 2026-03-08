import type { APIRoute } from "astro";
import {
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { rebuildSearchIndex } from "#db/documents.ts";

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");

      await verifySpaceRole(spaceId, user.id, "owner");

      await rebuildSearchIndex(spaceId);

      return successResponse("Search embeddings rebuilt successfully");
    },
    { fallbackMessage: "Failed to rebuild search embeddings" },
  );
