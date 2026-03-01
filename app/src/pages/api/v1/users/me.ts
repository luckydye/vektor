import type { APIRoute } from "astro";
import { jsonResponse, requireUser, withApiErrorHandling } from "#db/api.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    return jsonResponse({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    });
  }, "Failed to get current user");
