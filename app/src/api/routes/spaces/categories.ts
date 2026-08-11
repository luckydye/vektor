import {
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
  tryAuthenticateRequest,
} from "#acl/guards.ts";
import { Permission, PUBLIC_GROUP, ResourceType } from "#acl/permissions.ts";
import { getUserGroups, hasPermission, listAccessibleResources } from "#acl/store.ts";
import {
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getTokenUserId } from "#db/accessTokens.ts";
import { createCategory, listCategories, reorderCategories } from "#db/categories.ts";
import { getSpace } from "#db/spaces.ts";

async function visibleCategoryIds(
  context: Parameters<ApiRouteHandler>[0],
  spaceId: string,
) {
  if (context.req.raw.headers.get("X-Job-Token")) {
    await authenticateSpaceAccess(context, spaceId, Permission.VIEWER);
    return null;
  }

  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "user") {
    const groups = await getUserGroups(auth.user.id);
    const hasSpaceAccess = await hasPermission(
      spaceId,
      ResourceType.SPACE,
      spaceId,
      auth.user.id,
      Permission.VIEWER,
      groups,
    );
    if (hasSpaceAccess) return null;

    const ids = await listAccessibleResources(
      spaceId,
      auth.user.id,
      ResourceType.CATEGORY,
      groups,
      Permission.VIEWER,
    );
    if (!ids || ids.length === 0) throw forbiddenResponse();
    return new Set(ids);
  }

  if (auth?.type === "token") {
    const tokenUserId = getTokenUserId(auth.token.tokenId);
    const hasSpaceAccess = await hasPermission(
      spaceId,
      ResourceType.SPACE,
      spaceId,
      tokenUserId,
      Permission.VIEWER,
    );
    if (hasSpaceAccess) return null;

    const ids = await listAccessibleResources(
      spaceId,
      tokenUserId,
      ResourceType.CATEGORY,
      undefined,
      Permission.VIEWER,
    );
    if (!ids || ids.length === 0) throw forbiddenResponse();
    return new Set(ids);
  }

  const hasPublicSpaceAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    "",
    Permission.VIEWER,
    [PUBLIC_GROUP],
  );
  if (hasPublicSpaceAccess) return null;

  const ids = await listAccessibleResources(
    spaceId,
    "",
    ResourceType.CATEGORY,
    [PUBLIC_GROUP],
    Permission.VIEWER,
  );
  if (!ids || ids.length === 0) throw unauthorizedResponse();
  return new Set(ids);
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

    const categories = await listCategories(spaceId);
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
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(context, spaceId, Permission.EDITOR);

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

    const categoryData = await createCategory(
      spaceId,
      name,
      slug,
      description,
      color,
      icon,
    );
    return createdResponse({ category: categoryData });
  }, "Failed to create category");

export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(context, spaceId, Permission.EDITOR);

    const body = await parseJsonBody(context.req.raw);
    const { categoryIds } = body;

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      throw badRequestResponse("categoryIds array is required");
    }

    await reorderCategories(spaceId, categoryIds);
    return jsonResponse({ success: true });
  }, "Failed to reorder categories");
