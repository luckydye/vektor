import {
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
  tryAuthenticateRequest,
  verifyAccess,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  CategorySlugTakenError,
  deleteCategory,
  getCategory,
  updateCategory,
} from "#db/space/categories.ts";
import { isHexColor } from "#utils/color.ts";

async function verifyCategoryRead(
  context: Parameters<ApiRouteHandler>[0],
  spaceId: string,
  id: string,
) {
  if (context.req.raw.headers.get("X-Job-Token")) {
    await authenticateSpaceAccess(context, spaceId, Permission.VIEWER);
    return;
  }

  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "user") {
    await verifyAccess(
      spaceId,
      { type: ResourceType.CATEGORY, id: id },
      auth.user.id,
      Permission.VIEWER,
    );
    return;
  }
  if (auth?.type === "token") {
    await verifyAccess(
      spaceId,
      { type: ResourceType.CATEGORY, id: id },
      auth.token.tokenId,
      Permission.VIEWER,
    );
    return;
  }

  await verifyAccess(
    spaceId,
    { type: ResourceType.CATEGORY, id: id },
    null,
    Permission.VIEWER,
  );
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "id");
    await verifyCategoryRead(context, spaceId, id);

    const store = await openSpaceStore(spaceId);
    const categoryData = await getCategory(store, id);
    if (!categoryData) {
      throw notFoundResponse("Category");
    }

    return jsonResponse({ category: categoryData });
  }, "Failed to get category");

export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const id = requireParam(context.var.params, "id");
      await authenticateJobTokenOrSpaceRole(context, spaceId, Permission.EDITOR, {
        type: ResourceType.CATEGORY,
        id,
      });

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
      const categoryData = await updateCategory(store, id, {
        name,
        slug,
        description,
        color,
        icon,
      });

      if (!categoryData) {
        throw notFoundResponse("Category");
      }

      return jsonResponse({ category: categoryData });
    },
    {
      fallbackMessage: "Failed to update category",
      onError: (error) =>
        error instanceof CategorySlugTakenError
          ? badRequestResponse(error.message)
          : undefined,
    },
  );

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "id");
    await authenticateJobTokenOrSpaceRole(context, spaceId, Permission.EDITOR, {
      type: ResourceType.CATEGORY,
      id,
    });

    const store = await openSpaceStore(spaceId);
    await deleteCategory(store, id);
    return successResponse();
  }, "Failed to delete category");
