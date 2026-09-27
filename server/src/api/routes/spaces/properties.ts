import { authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listSpaceProperties } from "#db/space/properties.ts";

/**
 * List the document property keys used in a space, with their types
 *
 * @tag Documents
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.VIEWER);

    const store = await openSpaceStore(spaceId);
    const properties = await listSpaceProperties(store);

    return jsonResponse({ properties });
  }, "Failed to list space properties");
