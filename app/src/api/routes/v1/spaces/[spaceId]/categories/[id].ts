import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  successResponse,
  withApiErrorHandling,
} from "#db/api.ts";
import { deleteCategory, getCategory, updateCategory } from "#db/categories.ts";
import { authenticateJobTokenOrSpaceRole, authenticateSpaceAccess } from "#utils/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await authenticateSpaceAccess(context, spaceId, "viewer");

    const categoryData = await getCategory(spaceId, id);
    if (!categoryData) {
      throw notFoundResponse("Category");
    }

    return jsonResponse({ category: categoryData });
  }, "Failed to get category");

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    const body = await parseJsonBody(context.request);
    const { name, slug, description, color, icon } = body;

    if (!name || !slug) {
      throw badRequestResponse("Name and slug are required");
    }

    const categoryData = await updateCategory(
      spaceId,
      id,
      name,
      slug,
      description,
      color,
      icon,
    );

    if (!categoryData) {
      throw notFoundResponse("Category");
    }

    return jsonResponse({ category: categoryData });
  }, "Failed to update category");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    await deleteCategory(spaceId, id);
    return successResponse();
  }, "Failed to delete category");
