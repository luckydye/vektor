import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  getAllPropertiesWithValues,
  type PropertyInfo,
} from "#db/documents.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "viewer");

    const properties: PropertyInfo[] = await getAllPropertiesWithValues(spaceId);

    return jsonResponse({ properties });
  }, "Failed to list space properties");
