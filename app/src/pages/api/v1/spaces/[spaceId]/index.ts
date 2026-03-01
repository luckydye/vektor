import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { deleteSpace, getSpace, updateSpace } from "#db/spaces.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "viewer");
    const space = await getSpace(spaceId);
    return jsonResponse(space);
  }, "Failed to get space");

export const PATCH: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");

      const body = await parseJsonBody(context.request);
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

      if (updatesMetadata) {
        await verifySpaceRole(spaceId, user.id, "owner");
      } else {
        await verifySpaceRole(spaceId, user.id, "editor");
      }

      if (hasName && !name.trim()) {
        throw badRequestResponse("name must be a non-empty string");
      }

      if (hasSlug && !slug.trim()) {
        throw badRequestResponse("slug must be a non-empty string");
      }

      if (
        hasPreferences &&
        (typeof preferences !== "object" ||
          preferences === null ||
          Array.isArray(preferences))
      ) {
        throw badRequestResponse("preferences must be an object");
      }

      const space = await getSpace(spaceId);
      if (!space) {
        throw badRequestResponse("Space not found");
      }

      const updated = await updateSpace(
        spaceId,
        hasName ? name : space.name,
        hasSlug ? slug : space.slug,
        hasPreferences ? preferences : undefined,
      );

      return jsonResponse(updated);
    },
    {
      fallbackMessage: "Failed to update space",
      onError: (error) => {
        if (error instanceof Error && error.message.includes("already exists")) {
          return badRequestResponse(error.message);
        }
        return undefined;
      },
    },
  );

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");
    await deleteSpace(spaceId);
    return successResponse();
  }, "Failed to delete space");
