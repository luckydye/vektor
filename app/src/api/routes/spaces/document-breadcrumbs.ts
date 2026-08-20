import { tryAuthenticateRequest, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { requestCredentials } from "#api/acl.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocumentBreadcrumbs } from "#db/space/documents.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");

    const auth = await tryAuthenticateRequest(requestCredentials(context), spaceId);
    if (auth?.type === "user") {
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        auth.user.id,
        Permission.VIEWER,
      );
    } else {
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        null,
        Permission.VIEWER,
      );
    }

    const store = await openSpaceStore(spaceId);
    const breadcrumbs = await getDocumentBreadcrumbs(store, id);
    return jsonResponse({ breadcrumbs });
  }, "Failed to get document breadcrumbs");
