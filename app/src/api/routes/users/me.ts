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
    });
  }, "Failed to get current user");
