import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  tryAuthenticateRequest,
  verifyPublicSpaceRole,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocumentBreadcrumbs } from "#db/documents.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");

    const auth = await tryAuthenticateRequest(context, spaceId);
    if (auth?.type === "user") {
      await verifySpaceRole(spaceId, auth.user.id, "viewer");
    } else {
      await verifyPublicSpaceRole(spaceId, "viewer");
    }

    const breadcrumbs = await getDocumentBreadcrumbs(spaceId, id);
    return jsonResponse({ breadcrumbs });
  }, "Failed to get document breadcrumbs");
