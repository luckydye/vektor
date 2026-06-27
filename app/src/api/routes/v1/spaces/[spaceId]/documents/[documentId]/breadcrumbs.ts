import type { APIRoute } from "astro";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  tryAuthenticateRequest,
  verifyDocumentRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocumentBreadcrumbs } from "#db/documents.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");

    const auth = await tryAuthenticateRequest(context, spaceId);
    if (auth?.type === "user") {
      await verifyDocumentRole(spaceId, id, auth.user.id, "viewer");
    } else {
      await verifyDocumentRole(spaceId, id, null, "viewer");
    }

    const breadcrumbs = await getDocumentBreadcrumbs(spaceId, id);
    if (!breadcrumbs) {
      throw notFoundResponse("Document");
    }

    return jsonResponse({ breadcrumbs });
  }, "Failed to get document breadcrumbs");
