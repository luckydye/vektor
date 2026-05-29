import type { APIRoute } from "astro";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocument, getDocumentChildren } from "#db/documents.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");
    await verifyDocumentAccess(spaceId, id, user.id);

    const document = await getDocument(spaceId, id);
    if (!document) {
      throw notFoundResponse("Document");
    }

    const children = await getDocumentChildren(spaceId, id);
    return jsonResponse({ children });
  }, "Failed to list child documents");
