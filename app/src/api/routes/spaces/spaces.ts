import { extractAccessToken } from "#acl/guards.ts";
import {
  badRequestResponse,
  createdResponse,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  requirePreferencesSize,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { findSpaceForToken } from "#db/space/accessTokens.ts";
import {
  createSpace,
  getSpace,
  getUserSpaceRole,
  listPublicSpaces,
  listUserSpaces,
} from "#db/space/spaces.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const rawToken = extractAccessToken(context);
    if (rawToken) {
      const spaceId = await findSpaceForToken(rawToken);
      if (!spaceId) return jsonResponse([]);
      const space = await getSpace(spaceId);
      return jsonResponse(space ? [space] : []);
    }
    const user = context.var.user;
    if (user) {
      const spaces = await listUserSpaces(user.id);
      return jsonResponse(spaces);
    }
    // Unauthenticated — return spaces with public viewer access.
    const spaces = await listPublicSpaces();
    return jsonResponse(spaces);
  }, "Failed to list spaces");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const body = await parseJsonBody(context.req.raw);
      const { name, slug, preferences } = body;

      if (!name || typeof name !== "string" || !slug || typeof slug !== "string") {
        throw badRequestResponse("Name and slug are required");
      }

      requirePreferencesSize(preferences);

      const space = await createSpace(
        user.id,
        name,
        slug,
        preferences as Record<string, string> | undefined,
      );
      return createdResponse({
        space: { ...space, userRole: await getUserSpaceRole(space, user.id) },
      });
    },
    {
      fallbackMessage: "Failed to create space",
      onError: (error) => {
        if (error instanceof Error && error.message.includes("already exists")) {
          return badRequestResponse(error.message);
        }
        if (
          error instanceof Error &&
          error.message.includes("No hosted space database is available")
        ) {
          return errorResponse(error.message, 503);
        }
        return undefined;
      },
    },
  );
