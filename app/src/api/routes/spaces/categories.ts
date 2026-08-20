import { authenticateJobTokenOrSpaceRole, authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  CategorySlugTakenError,
  createCategory,
  listCategories,
  reorderCategories,
} from "#db/space/categories.ts";
import { getSpace } from "#db/space/spaces.ts";
import { isHexColor } from "#utils/color.ts";

/**
 * The categories the caller may see: `null` when a space-wide role carries all
 * of them, otherwise the ids their category grants reach.
 */
async function visibleCategoryIds(
  context: Parameters<ApiRouteHandler>[0],
  spaceId: string,
) {
  const access = await authenticateSpaceAccess(
    context.var.credentials,
    spaceId,
    Permission.VIEWER,
    {
      allowResourceGrants: true,
      scopeType: ResourceType.CATEGORY,
    },
  );
  return access.resourceScope ? new Set(access.resourceScope) : null;
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const space = await getSpace(spaceId);
    if (!space) {
      return new Response("Space not found", {
        status: 404,
        statusText: "Space not found",
      });
    }

    const visibleIds = await visibleCategoryIds(context, spaceId);

    const store = await openSpaceStore(spaceId);
    const categories = await listCategories(store);
    const visibleCategories = visibleIds
      ? categories.filter((category) => visibleIds.has(category.id))
      : categories;

    return jsonResponse({
      categories: visibleCategories,
      // Lets the client tell "this space truly has no categories" apart from
      // "categories exist here, but none are visible to you" — the two
      // render very different empty states.
      hasHiddenCategories: visibleCategories.length < categories.length,
    });
  }, "Failed to list categories");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      await authenticateJobTokenOrSpaceRole(
        context.var.credentials,
        spaceId,
        Permission.EDITOR,
      );

      const body = (await parseJsonBody(context.req.raw)) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const slug = typeof body.slug === "string" ? body.slug : undefined;
      const description =
        typeof body.description === "string" ? body.description : undefined;
      const color = typeof body.color === "string" ? body.color : undefined;
      const icon = typeof body.icon === "string" ? body.icon : undefined;

      if (!name || !slug) {
        throw badRequestResponse("Name and slug are required");
      }

      // A category colour is rendered into a style attribute for every member.
      if (color && !isHexColor(color)) {
        throw badRequestResponse("color must be a hex color, e.g. #4ecdc4");
      }

      const store = await openSpaceStore(spaceId);
      const categoryData = await createCategory(store, {
        name,
        slug,
        description,
        color,
        icon,
      });
      return createdResponse({ category: categoryData });
    },
    {
      fallbackMessage: "Failed to create category",
      onError: (error) =>
        error instanceof CategorySlugTakenError
          ? badRequestResponse(error.message)
          : undefined,
    },
  );

export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(
      context.var.credentials,
      spaceId,
      Permission.EDITOR,
    );

    const body = await parseJsonBody(context.req.raw);
    const { categoryIds } = body;

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      throw badRequestResponse("categoryIds array is required");
    }

    const store = await openSpaceStore(spaceId);
    await reorderCategories(store, categoryIds);
    return jsonResponse({ success: true });
  }, "Failed to reorder categories");
