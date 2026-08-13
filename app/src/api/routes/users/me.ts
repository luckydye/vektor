import { canCreateSpace } from "#acl/spaceCreation.ts";
import { jsonResponse, requireUser, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { resolveProfileImage } from "#utils/gravatar.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    return jsonResponse({
      id: user.id,
      name: user.name,
      email: user.email,
      image: resolveProfileImage(user),
      // What the caller may do that is not scoped to a space, so there is no
      // space-level `permissions/me` to carry it.
      canCreateSpace: await canCreateSpace(user.id),
    });
  }, "Failed to get current user");
