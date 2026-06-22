import type { APIRoute } from "astro";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { createCategory, listCategories, reorderCategories } from "#db/categories.ts";
import { authenticateJobTokenOrSpaceRole, authenticateSpaceAccess } from "#utils/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await authenticateSpaceAccess(context, spaceId, "viewer");

    const categories = await listCategories(spaceId);

    return jsonResponse({ categories });
  }, "Failed to list categories");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    const body = await parseJsonBody(context.request);
    const { name, slug, description, color, icon } = body;

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
