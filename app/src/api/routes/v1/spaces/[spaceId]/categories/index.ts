import type { APIRoute } from "astro";
import { getTokenUserId } from "#db/accessTokens.ts";
import {
  getUserGroups,
  hasPermission,
  listAccessibleResources,
  ResourceType,
} from "#db/acl.ts";
import {
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  tryAuthenticateRequest,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#db/api.ts";
import { createCategory, listCategories, reorderCategories } from "#db/categories.ts";
import { authenticateJobTokenOrSpaceRole, authenticateSpaceAccess } from "#utils/auth.ts";

async function visibleCategoryIds(context: Parameters<APIRoute>[0], spaceId: string) {
  if (context.request.headers.get("X-Job-Token")) {
    await authenticateSpaceAccess(context, spaceId, "viewer");
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
      "viewer",
      groups,
    );
    if (hasSpaceAccess) return null;

    const ids = await listAccessibleResources(
      spaceId,
      auth.user.id,
      ResourceType.CATEGORY,
      groups,
      "viewer",
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
      "viewer",
    );
    if (hasSpaceAccess) return null;

    const ids = await listAccessibleResources(
      spaceId,
      tokenUserId,
      ResourceType.CATEGORY,
      undefined,
      "viewer",
    );
    if (!ids || ids.length === 0) throw forbiddenResponse();
    return new Set(ids);
  }

  const hasPublicSpaceAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    "",
    "viewer",
    ["public"],
  );
  if (hasPublicSpaceAccess) return null;

  const ids = await listAccessibleResources(
    spaceId,
    "",
    ResourceType.CATEGORY,
    ["public"],
    "viewer",
  );
  if (!ids || ids.length === 0) throw unauthorizedResponse();
  return new Set(ids);
}

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const visibleIds = await visibleCategoryIds(context, spaceId);

    const categories = await listCategories(spaceId);

    return jsonResponse({
      categories: visibleIds
        ? categories.filter((category) => visibleIds.has(category.id))
        : categories,
    });
  }, "Failed to list categories");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    const body = (await parseJsonBody(context.request)) as Record<string, unknown>;
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

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    const body = await parseJsonBody(context.request);
    const { categoryIds } = body;

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      throw badRequestResponse("categoryIds array is required");
    }

    await reorderCategories(spaceId, categoryIds);
    return jsonResponse({ success: true });
  }, "Failed to reorder categories");
