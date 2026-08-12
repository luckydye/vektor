import { verifyResourceAccess, verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  requireValidPreferences,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  deleteSpace,
  getSpace,
  getUserSpaceRole,
  InvalidSpaceSlugError,
  SpaceSlugTakenError,
  updateSpace,
} from "#db/space/spaces.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyResourceAccess(spaceId, user.id);
    const space = await getSpace(spaceId);
    if (!space) return jsonResponse(space);
    return jsonResponse({ ...space, userRole: await getUserSpaceRole(space, user.id) });
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

      const validatedPreferences = requireValidPreferences(preferences);

      const updatesWorkflowCreationPreference =
        validatedPreferences !== undefined &&
        Object.hasOwn(validatedPreferences, spacePreferenceKeys.workflowCreationEnabled);

      if (updatesMetadata || updatesWorkflowCreationPreference) {
        await verifySpaceRole(spaceId, user.id, Permission.OWNER);
      } else {
        await verifySpaceRole(spaceId, user.id, Permission.EDITOR);
      }

      const space = await getSpace(spaceId);
      if (!space) {
        throw badRequestResponse("Space not found");
      }

      const updated = await updateSpace(
        spaceId,
        hasName ? name : space.name,
        hasSlug ? slug : space.slug,
        validatedPreferences,
      );

      if (!updated) {
        throw badRequestResponse("Space not found");
      }

      return jsonResponse({
        ...updated,
        userRole: await getUserSpaceRole(updated, user.id),
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
    await verifySpaceRole(spaceId, user.id, Permission.OWNER);
    await deleteSpace(spaceId);
    return successResponse();
  }, "Failed to delete space");
