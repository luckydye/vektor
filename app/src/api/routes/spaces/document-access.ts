import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { listDocumentAccess } from "#acl/store.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

// GET /api/v1/spaces/:spaceId/documents/:documentId/access
// Everyone who can reach this document, and the grant that gets them there.
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    // Editor on the document is what it takes to change sharing, so it is also
    // what it takes to see who the document is shared with.
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      user.id,
      Permission.EDITOR,
    );

    const access = await listDocumentAccess(spaceId, documentId);
    return jsonResponse({ access });
  }, "Failed to list document access");
