import { authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAllPropertiesWithValues, type PropertyInfo } from "#db/documents.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(context, spaceId, Permission.VIEWER);

    const properties: PropertyInfo[] = await getAllPropertiesWithValues(spaceId);

    return jsonResponse({ properties });
  }, "Failed to list space properties");
