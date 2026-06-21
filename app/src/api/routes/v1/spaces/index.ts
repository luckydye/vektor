import type { APIRoute } from "astro";
import {
  badRequestResponse,
  createdResponse,
  extractAccessToken,
  jsonResponse,
  parseJsonBody,
  requireUser,
  withApiErrorHandling,
} from "#db/api.ts";
import { findSpaceForToken } from "#db/accessTokens.ts";
import { createSpace, getSpace, listUserSpaces } from "#db/spaces.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const rawToken = extractAccessToken(context);
    if (rawToken) {
      const spaceId = await findSpaceForToken(rawToken);
      if (!spaceId) return jsonResponse([]);
      const space = await getSpace(spaceId);
      return jsonResponse(space ? [space] : []);
    }
    const user = requireUser(context);
    const spaces = await listUserSpaces(user.id);
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
