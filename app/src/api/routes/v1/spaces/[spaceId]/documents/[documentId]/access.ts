import type { ApiRouteHandler } from "#api/server/types.ts";
import { listDocumentAccess } from "#db/acl.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifyDocumentRole,
  withApiErrorHandling,
} from "#db/api.ts";

// GET /api/v1/spaces/:spaceId/documents/:documentId/access
// Everyone who can reach this document, and the grant that gets them there.
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    // Editor on the document is what it takes to change sharing, so it is also
    // what it takes to see who the document is shared with.
    await verifyDocumentRole(spaceId, documentId, user.id, "editor");

    const access = await listDocumentAccess(spaceId, documentId);
    return jsonResponse({ access });
  }, "Failed to list document access");
