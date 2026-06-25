import type { APIRoute } from "astro";
import { Feature } from "#db/acl.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBodyOrEmpty,
  parseQueryInt,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  verifyDocumentRole,
  verifyFeatureAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  getRevisionMetadata,
  listRevisionMetadata,
  restoreRevision,
  updateRevisionStatus,
} from "#db/revisions.ts";

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

export const PATCH: APIRoute = (context) =>
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
    const body = await parseJsonBodyOrEmpty<{ status?: unknown }>(context.request);
    const status = body.status;

    if (status !== "open" && status !== "applied" && status !== "dismissed") {
      throw badRequestResponse('Status must be "open", "applied", or "dismissed"');
    }

    const currentRevision = await getRevisionMetadata(spaceId, documentId, rev);
    if (!currentRevision) {
      throw notFoundResponse("Revision");
    }
    if (currentRevision.status === null) {
      throw badRequestResponse("Revision is not a suggestion");
    }

    const revision = await updateRevisionStatus(spaceId, documentId, rev, status);
    if (!revision) {
      throw notFoundResponse("Revision");
    }

    return jsonResponse({ revision });
  }, "Failed to update revision status");
