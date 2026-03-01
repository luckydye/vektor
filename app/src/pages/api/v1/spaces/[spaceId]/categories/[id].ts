import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  deleteCategory,
  getCategory,
  updateCategory,
} from "#db/categories.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await verifySpaceRole(spaceId, user.id, "viewer");

    const categoryData = await getCategory(spaceId, id);
    if (!categoryData) {
      throw notFoundResponse("Category");
    }

    return jsonResponse({ category: categoryData });
  }, "Failed to get category");

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await verifySpaceRole(spaceId, user.id, "editor");

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
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await verifySpaceRole(spaceId, user.id, "editor");

    await deleteCategory(spaceId, id);
    return successResponse();
  }, "Failed to delete category");
