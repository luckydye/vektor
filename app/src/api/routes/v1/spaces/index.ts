import type { APIRoute } from "astro";
import { findSpaceForToken } from "#db/accessTokens.ts";
import {
  badRequestResponse,
  createdResponse,
  extractAccessToken,
  jsonResponse,
  parseJsonBody,
  requireUser,
  withApiErrorHandling,
} from "#db/api.ts";
import { createSpace, getSpace, listPublicSpaces, listUserSpaces } from "#db/spaces.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const rawToken = extractAccessToken(context);
    if (rawToken) {
      const spaceId = await findSpaceForToken(rawToken);
      if (!spaceId) return jsonResponse([]);
      const space = await getSpace(spaceId);
      return jsonResponse(space ? [space] : []);
    }
    const user = context.locals.user;
    if (user) {
      const spaces = await listUserSpaces(user.id);
      return jsonResponse(spaces);
    }
    // Unauthenticated — return spaces with public viewer access.
    const spaces = await listPublicSpaces();
    return jsonResponse(spaces);
  }, "Failed to list spaces");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const body = await parseJsonBody(context.request);
      const { name, slug, preferences } = body;

      if (!name || !slug) {
        throw badRequestResponse("Name and slug are required");
      }

      const space = await createSpace(user.id, name, slug, preferences);
      return createdResponse({ space });
    },
    {
      fallbackMessage: "Failed to create space",
      onError: (error) => {
        if (error instanceof Error && error.message.includes("already exists")) {
          return badRequestResponse(error.message);
        }
        return undefined;
      },
    },
  );
