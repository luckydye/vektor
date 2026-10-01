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
 * @query parentId Only the keys this document's direct children use, e.g. a database's columns.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.VIEWER);

    const store = await openSpaceStore(spaceId);
    const parentId = new URL(context.req.url).searchParams.get("parentId") ?? undefined;
    const properties = await listSpaceProperties(store, { parentId });

    return jsonResponse({ properties });
  }, "Failed to list space properties");
