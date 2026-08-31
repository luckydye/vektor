import { verifyAccess } from "#acl/guards.ts";
import { isResourceType, Permission, ResourceType } from "#acl/permissions.ts";
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
 * Revoke a share link
 *
 * @tag Sharing
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const linkId = requireParam(context.var.params, "linkId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.EDITOR,
    );

    const store = await openSpaceStore(spaceId);
    const link = await getShareLink(store, linkId);
    if (!link || !isResourceType(link.resourceType)) {
      throw notFoundResponse("Share link");
    }

    await revokeShareLink(store, link, user.id);
    return successResponse({ message: "Share link revoked" });
  }, "Failed to revoke share link");
