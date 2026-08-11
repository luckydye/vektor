import { jsonResponse, requireUser, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

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
