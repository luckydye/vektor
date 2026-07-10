import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  jsonResponse,
  requireParam,
  tryAuthenticateRequest,
  verifyPublicSpaceRole,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocumentBreadcrumbs } from "#db/documents.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");

    const auth = await tryAuthenticateRequest(context, spaceId);
    if (auth?.type === "user") {
      await verifySpaceRole(spaceId, auth.user.id, "viewer");
    } else {
      await verifyPublicSpaceRole(spaceId, "viewer");
    }

    const breadcrumbs = await getDocumentBreadcrumbs(spaceId, id);
    return jsonResponse({ breadcrumbs });
  }, "Failed to get document breadcrumbs");
