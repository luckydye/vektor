import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  deleteSpace,
  getSpace,
  getUserSpaceRole,
  InvalidSpaceSlugError,
  SpaceSlugTakenError,
  updateSpace,
} from "#db/space/spaces.ts";
import { getUserPreferences, setUserPreferences } from "#db/space/userPreferences.ts";
import {
  requiredPreferenceWriteRole,
  splitPreferencesByScope,
  validateSpacePreferences,
} from "#utils/spacePreferences.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId, anyGrantInSpace: true },
      user.id,
      Permission.VIEWER,
    );
    const space = await getSpace(spaceId);
    if (!space) return jsonResponse(space);
    return jsonResponse({
      ...space,
      userRole: await getUserSpaceRole(space, user.id),
      userPreferences: await getUserPreferences(await openSpaceStore(spaceId), user.id),
    });
  }, "Failed to get space");

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");

      const body = await parseJsonBody(context.req.raw);
      const { name, slug, preferences } = body;

      const hasName = typeof name === "string";
      const hasSlug = typeof slug === "string";
      const hasPreferences = preferences !== undefined;
      const updatesMetadata = hasName || hasSlug;

      if (!updatesMetadata && !hasPreferences) {
        throw badRequestResponse(
          "At least one of name, slug, or preferences is required",
        );
      }

      if (hasName && !name.trim()) {
        throw badRequestResponse("name must be a non-empty string");
      }

      if (hasSlug && !slug.trim()) {
        throw badRequestResponse("slug must be a non-empty string");
      }

      const validated = validateSpacePreferences(preferences);
      if ("error" in validated) throw badRequestResponse(validated.error);

      // Preferences are open, so the role follows what is being written rather
      // than the fact that something is: a preference in a namespace that decides
      // something space-wide takes that namespace's role, a member's own takes
      // `VIEWER`, and everything else is an editor's to change.
      const { space: spacePreferences, user: userPreferences } = splitPreferencesByScope(
        validated.preferences ?? {},
      );

      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        updatesMetadata
          ? Permission.OWNER
          : requiredPreferenceWriteRole(validated.preferences),
      );

      const space = await getSpace(spaceId);
      if (!space) {
        throw badRequestResponse("Space not found");
      }

      // A write of nothing but the member's own preferences does not touch the
      // space: `updateSpace` would restamp its `updatedAt` and reindex it, which
      // is not something storing one's own sidebar state should do.
      const writesSpace = updatesMetadata || Object.keys(spacePreferences).length > 0;
      const updated = writesSpace
        ? await updateSpace(
            spaceId,
            hasName ? name : space.name,
            hasSlug ? slug : space.slug,
            // Only the space's own half — `updateSpace` writes the rows with no
            // user, and a member's preferences are not the space's to hold.
            spacePreferences,
          )
        : space;

      if (!updated) {
        throw badRequestResponse("Space not found");
      }

      const store = await openSpaceStore(spaceId);
      await setUserPreferences(store, user.id, userPreferences);

      return jsonResponse({
        ...updated,
        userRole: await getUserSpaceRole(updated, user.id),
        // Set on every response carrying a space, for the same reason `userRole`
        // is: the client caches spaces by id, and a response that omits it
        // overwrites what the last one established.
        userPreferences: await getUserPreferences(store, user.id),
      });
    },
    {
      fallbackMessage: "Failed to update space",
      onError: (error) => {
        if (
          error instanceof InvalidSpaceSlugError ||
          error instanceof SpaceSlugTakenError
        ) {
          return badRequestResponse(error.message);
        }
        return undefined;
      },
    },
  );

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );
    await deleteSpace(spaceId);
    return successResponse();
  }, "Failed to delete space");
