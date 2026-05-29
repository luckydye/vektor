import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  Feature,
  hasFeature,
  getUserGroups,
  getPermission,
  ResourceType,
} from "#db/acl.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceAccess(spaceId, user.id);

    const userGroups = await getUserGroups(user.id);

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
      features[feature] = await hasFeature(spaceId, feature, user.id, userGroups);
    }

    return jsonResponse({
      role,
      features,
      groups: userGroups,
    });
  }, "Failed to get permission summary");
