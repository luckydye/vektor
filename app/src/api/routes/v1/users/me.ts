import type { ApiRouteHandler } from "#api/server/types.ts";
import { jsonResponse, requireUser, withApiErrorHandling } from "#db/api.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    return jsonResponse({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    });
  }, "Failed to get current user");
