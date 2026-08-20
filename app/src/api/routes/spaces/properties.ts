import { authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { requestCredentials } from "#api/acl.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getAllPropertiesWithValues } from "#db/space/properties.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(
      requestCredentials(context),
      spaceId,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const properties = await getAllPropertiesWithValues(store);

    return jsonResponse({ properties });
  }, "Failed to list space properties");
