import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import {
  jsonResponse,
  notFoundResponse,
  requireUser,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuthDb } from "#db/db.ts";
import { user } from "#db/schema/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    requireUser(context);

    const db = getAuthDb();
    const id = context.url.searchParams.get("id");

    if (id) {
      const result = await db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        })
        .from(user)
        .where(eq(user.id, id))
        .get();

      if (!result) {
        throw notFoundResponse("User");
      }

      return jsonResponse(result);
    }

    const users = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(user);

    return jsonResponse(users);
  }, "Failed to list users");
