import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBodyOrEmpty,
  parseQueryInt,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  verifyFeatureAccess,
  verifyDocumentRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  listRevisionMetadata,
  restoreRevision,
} from "#db/revisions.ts";
import { Feature } from "#db/acl.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Verify user has history viewing feature access
    await verifyFeatureAccess(spaceId, Feature.VIEW_HISTORY, user.id);

    const revisions = await listRevisionMetadata(spaceId, documentId);

    return jsonResponse({ revisions });
  }, "Failed to list revisions");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");
    const revParam = context.url.searchParams.get("rev");

    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }

    await verifyDocumentRole(spaceId, documentId, user.id, "editor");

    const rev = parseQueryInt(context.url.searchParams, "rev", { min: 1 });

    const body = await parseJsonBodyOrEmpty<{ message?: string }>(context.request);
    const message = typeof body.message === "string" ? body.message : undefined;
    const revision = await restoreRevision(spaceId, documentId, rev, user.id, message);

    return jsonResponse({
      revision: {
        id: revision.id,
        documentId: revision.documentId,
        rev: revision.rev,
        checksum: revision.checksum,
        parentRev: revision.parentRev,
        status: revision.status,
        message: revision.message,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
      },
    });
  }, "Failed to restore revision");
