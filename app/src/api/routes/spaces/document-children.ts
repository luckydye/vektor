import { verifyAccess } from "#acl/guards.ts";
import { resolveIdentity } from "#acl/identity.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { listAccessibleResources } from "#acl/store.ts";
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

/**
 * The document's direct children
 *
 * @tag Documents
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: id },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const document = await getDocument(store, id);
    if (!document) {
      throw notFoundResponse("Document");
    }

    const identity = await resolveIdentity(user.id);
    const children = await getDocumentChildren(store, id, {
      userId: user.id,
      userGroups: identity.groups,
      // Access to this parent can come from a grant on the parent alone. Without
      // the scope, children with no ACL entry of their own would fall back to a
      // space role the caller does not hold and be enumerable.
      documentScope: await listAccessibleResources(
        spaceId,
        identity,
        ResourceType.DOCUMENT,
        Permission.VIEWER,
      ),
    });
    return jsonResponse({ children });
  }, "Failed to list child documents");
