import { verifyAccess } from "#acl/guards.ts";
import { resolveIdentity } from "#acl/identity.ts";
import { Feature, Permission, ResourceType } from "#acl/permissions.ts";
import { getPermission, hasFeature } from "#acl/store.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const identity = await resolveIdentity(user.id);
    const userGroups = identity.groups;

    // Get user's space role
    const spacePermission = await getPermission(
      spaceId,
      ResourceType.SPACE,
      spaceId,
      user.id,
      userGroups,
    );
    const role = spacePermission?.permission || null;

    // Check each feature
    const features: Record<string, boolean> = {};
    for (const feature of Object.values(Feature)) {
      features[feature] = await hasFeature(spaceId, feature, identity);
    }

    return jsonResponse({
      role,
      features,
      groups: userGroups,
    });
  }, "Failed to get permission summary");
