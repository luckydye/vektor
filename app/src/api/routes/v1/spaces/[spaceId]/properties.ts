import type { ApiRouteHandler } from "#api/server/types.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#db/api.ts";
import { getAllPropertiesWithValues, type PropertyInfo } from "#db/documents.ts";
import { authenticateSpaceAccess } from "#utils/auth.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(context, spaceId, "viewer");

    const properties: PropertyInfo[] = await getAllPropertiesWithValues(spaceId);

    return jsonResponse({ properties });
  }, "Failed to list space properties");
