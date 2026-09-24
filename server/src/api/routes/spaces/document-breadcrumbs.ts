import { authenticateDocumentAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocumentBreadcrumbs } from "#db/space/documents.ts";

/**
 * The document's ancestors, root first
 *
 * @tag Documents
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");

    // A title and its ancestor path are visible to the whole space by policy, so
    // any grant inside it reaches them. Routed through the document guard all the
    // same, to inherit the rules a document's own state carries.
    await authenticateDocumentAccess(
      context.var.credentials,
      spaceId,
      id,
      Permission.VIEWER,
      { anyGrantInSpace: true },
    );

    const store = await openSpaceStore(spaceId);
    const breadcrumbs = await getDocumentBreadcrumbs(store, id);
    return jsonResponse({ breadcrumbs });
  }, "Failed to get document breadcrumbs");
