import { extractAccessToken } from "#acl/guards.ts";
import { spaceCreationRejection } from "#acl/identity.ts";
import {
  badRequestResponse,
  createdResponse,
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { findSpaceForToken } from "#db/space/accessTokens.ts";
import {
  createSpace,
  getSpace,
  getUserSpaceRole,
  InvalidSpaceSlugError,
  listPublicSpaces,
  listUserSpaces,
  SpaceSlugTakenError,
} from "#db/space/spaces.ts";
import { setUserPreferences } from "#db/space/userPreferences.ts";
import {
  splitPreferencesByScope,
  validateSpacePreferences,
} from "#utils/spacePreferences.ts";

/**
 * List the spaces the caller can read
 *
 * A session lists the caller's spaces, an access token the single space it belongs to, and an anonymous caller the publicly readable ones.
 *
 * @tag Spaces
 * @response array #/components/schemas/Space
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const rawToken = extractAccessToken(context.var.credentials);
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

/**
 * Create a space
 *
 * @tag Spaces
 * @status 201
 * @body
 * @response #/components/schemas/CreatedSpace
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const rejection = await spaceCreationRejection(user.id);
      if (rejection) throw forbiddenResponse(rejection);

      const body = await parseJsonBody(context.req.raw);
      const { name, slug, preferences } = body;

      if (!name || typeof name !== "string" || !slug || typeof slug !== "string") {
        throw badRequestResponse("Name and slug are required");
      }

      const validated = validateSpacePreferences(preferences);
      if ("error" in validated) throw badRequestResponse(validated.error);

      // The two halves go to different stores, here as on the update path: the
      // space's preferences are the space's, a `user:` one is the creator's own.
      const { space: spacePreferences, user: userPreferences } = splitPreferencesByScope(
        validated.preferences ?? {},
      );

      const space = await createSpace(
        user.id,
        name,
        slug,
        validated.preferences === undefined ? undefined : spacePreferences,
      );
      await setUserPreferences(await openSpaceStore(space.id), user.id, userPreferences);

      return createdResponse({
        space: {
          ...space,
          userRole: await getUserSpaceRole(space, user.id),
          // Set wherever a space is returned, like `userRole`: the client caches
          // spaces by id, so a response that omits it overwrites what is stored.
          userPreferences,
        },
      });
    },
    {
      fallbackMessage: "Failed to create space",
      onError: (error) => {
        if (
          error instanceof InvalidSpaceSlugError ||
          error instanceof SpaceSlugTakenError
        ) {
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
