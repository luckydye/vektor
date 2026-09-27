import { authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseQueryInt,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listPropertyValues } from "#db/space/properties.ts";

/**
 * List the distinct values documents hold for one property key
 *
 * @tag Documents
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.VIEWER);

    const searchParams = new URL(context.req.url).searchParams;
    const key = searchParams.get("key");
    if (!key) throw badRequestResponse("key is required");
    const limit = parseQueryInt(searchParams, "limit", { defaultValue: 50, min: 1, max: 500 });

    const store = await openSpaceStore(spaceId);
    const result = await listPropertyValues(store, key, {
      prefix: searchParams.get("prefix") ?? "",
      limit,
    });

    return jsonResponse(result);
  }, "Failed to list property values");
