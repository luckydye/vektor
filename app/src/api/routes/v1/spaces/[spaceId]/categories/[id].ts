import type { APIRoute } from "astro";
import { ResourceType } from "#db/acl.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  successResponse,
  tryAuthenticateRequest,
  verifyCategoryRole,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import { deleteCategory, getCategory, updateCategory } from "#db/categories.ts";
import { authenticateJobTokenOrSpaceRole, authenticateSpaceAccess } from "#utils/auth.ts";

async function verifyCategoryRead(context: Parameters<APIRoute>[0], spaceId: string, id: string) {
  if (context.request.headers.get("X-Job-Token")) {
    await authenticateSpaceAccess(context, spaceId, "viewer");
    return;
  }

  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "user") {
    await verifyCategoryRole(spaceId, id, auth.user.id, "viewer");
    return;
  }
  if (auth?.type === "token") {
    await verifyTokenPermission(auth.token, spaceId, ResourceType.CATEGORY, id, "viewer");
    return;
  }

  await verifyCategoryRole(spaceId, id, null, "viewer");
}

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "id");
    await verifyCategoryRead(context, spaceId, id);

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
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor", {
      type: ResourceType.CATEGORY,
      id,
    });

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
    await authenticateJobTokenOrSpaceRole(context, spaceId, "editor", {
      type: ResourceType.CATEGORY,
      id,
    });

    await deleteCategory(spaceId, id);
    return successResponse();
  }, "Failed to delete category");
