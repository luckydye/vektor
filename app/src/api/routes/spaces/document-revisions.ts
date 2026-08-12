import {
  verifyDocumentAccess,
  verifyDocumentRole,
  verifyFeatureAccess,
} from "#acl/guards.ts";
import { Feature, Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBodyOrEmpty,
  parseQueryInt,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  getRevisionMetadata,
  listRevisionMetadata,
  restoreRevision,
  updateRevisionStatus,
} from "#db/space/revisions.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Verify user has history viewing feature access
    await verifyFeatureAccess(spaceId, Feature.VIEW_HISTORY, user.id);

    const store = await openSpaceStore(spaceId);
    const revisions = await listRevisionMetadata(store, documentId);

    return jsonResponse({ revisions });
  }, "Failed to list revisions");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    // Authorized before the query is read: a caller who may not edit this
    // document should get that verdict, not a complaint about `rev`.
    await verifyDocumentRole(spaceId, documentId, user.id, Permission.EDITOR);

    const revParam = new URL(context.req.url).searchParams.get("rev");
    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }

    const rev = parseQueryInt(new URL(context.req.url).searchParams, "rev", { min: 1 });

    const body = await parseJsonBodyOrEmpty<{ message?: string }>(context.req.raw);
    const message = typeof body.message === "string" ? body.message : undefined;
    const store = await openSpaceStore(spaceId);
    const revision = await restoreRevision(store, documentId, rev, user.id, message);
    if (!revision) {
      throw notFoundResponse("Revision");
    }

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

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    // Authorized before the query is read: a caller who may not edit this
    // document should get that verdict, not a complaint about `rev`.
    await verifyDocumentRole(spaceId, documentId, user.id, Permission.EDITOR);

    const revParam = new URL(context.req.url).searchParams.get("rev");
    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }

    const rev = parseQueryInt(new URL(context.req.url).searchParams, "rev", { min: 1 });
    const body = await parseJsonBodyOrEmpty<{ status?: unknown }>(context.req.raw);
    const status = body.status;

    if (status !== "open" && status !== "applied" && status !== "dismissed") {
      throw badRequestResponse('Status must be "open", "applied", or "dismissed"');
    }

    const store = await openSpaceStore(spaceId);
    const currentRevision = await getRevisionMetadata(store, documentId, rev);
    if (!currentRevision) {
      throw notFoundResponse("Revision");
    }
    if (currentRevision.status === null) {
      throw badRequestResponse("Revision is not a suggestion");
    }

    const revision = await updateRevisionStatus(store, documentId, rev, status);
    if (!revision) {
      throw notFoundResponse("Revision");
    }

    return jsonResponse({ revision });
  }, "Failed to update revision status");
