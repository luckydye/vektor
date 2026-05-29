import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { listArchivedDocuments } from "#db/documents.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceAccess(spaceId, user.id);
    const documents = await listArchivedDocuments(spaceId, user.id);
    return jsonResponse({ documents });
  }, "Failed to list archived documents");
