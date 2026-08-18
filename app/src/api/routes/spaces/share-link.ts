import { verifyAccess } from "#acl/guards.ts";
import { isResourceType, Permission } from "#acl/permissions.ts";
import {
  notFoundResponse,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getShareLink, revokeShareLink } from "#db/space/shareLinks.ts";

/**
 * DELETE /api/v1/spaces/:spaceId/share-links/:linkId
 * Revoke a share link. The row and its grant stay, so this is reversible.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const linkId = requireParam(context.var.params, "linkId");

    const store = await openSpaceStore(spaceId);
    const link = await getShareLink(store, linkId);
    if (!link || !isResourceType(link.resourceType)) {
      throw notFoundResponse("Share link");
    }

    // Authorized on what the link shares: whoever may share it may take it back.
    await verifyAccess(
      spaceId,
      { type: link.resourceType, id: link.resourceId },
      user.id,
      Permission.EDITOR,
    );

    await revokeShareLink(store, linkId, user.id);
    return successResponse({ message: "Share link revoked" });
  }, "Failed to revoke share link");
