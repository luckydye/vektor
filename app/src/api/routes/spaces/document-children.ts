import { verifyDocumentAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { getUserGroups, listAccessibleResources } from "#acl/store.ts";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument, getDocumentChildren } from "#db/space/documents.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    await verifyDocumentAccess(spaceId, id, user.id);

    const store = await openSpaceStore(spaceId);
    const document = await getDocument(store, id);
    if (!document) {
      throw notFoundResponse("Document");
    }

    const userGroups = await getUserGroups(user.id);
    const children = await getDocumentChildren(store, id, {
      userId: user.id,
      userGroups,
      // Access to this parent can come from a grant on the parent alone. Without
      // the scope, children with no ACL entry of their own would fall back to a
      // space role the caller does not hold and be enumerable.
      documentScope: await listAccessibleResources(
        spaceId,
        user.id,
        ResourceType.DOCUMENT,
        userGroups,
        Permission.VIEWER,
      ),
    });
    return jsonResponse({ children });
  }, "Failed to list child documents");
