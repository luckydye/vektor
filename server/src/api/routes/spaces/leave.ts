import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { leaveSpace } from "#acl/roleWrites.ts";
import {
  badRequestResponse,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * Leave a space
 *
 * Revokes every grant that names the caller, so a space they were invited to
 * stops appearing in their listing and stops authorizing their requests.
 *
 * @tag Spaces
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId, anyGrantInSpace: true },
      user.id,
      Permission.VIEWER,
    );

    const result = await leaveSpace(context.var.platform, spaceId, user.id);
    if (result.outcome === "owner") {
      throw badRequestResponse(
        "Owners cannot leave a space; transfer ownership or delete it instead",
      );
    }
    if (result.outcome === "group-member") {
      throw badRequestResponse(
        "Your access comes from a group, so an owner has to remove you",
      );
    }
    if (result.outcome === "not-a-member") {
      throw badRequestResponse("You are not a member of this space");
    }

    return successResponse();
  }, "Failed to leave space");
