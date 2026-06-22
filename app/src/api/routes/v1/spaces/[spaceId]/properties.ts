import type { APIRoute } from "astro";
import { jsonResponse, requireParam, withApiErrorHandling } from "#db/api.ts";
import { getAllPropertiesWithValues, type PropertyInfo } from "#db/documents.ts";
import { authenticateSpaceAccess } from "#utils/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await authenticateSpaceAccess(context, spaceId, "viewer");

    const properties: PropertyInfo[] = await getAllPropertiesWithValues(spaceId);

    return jsonResponse({ properties });
  }, "Failed to list space properties");
