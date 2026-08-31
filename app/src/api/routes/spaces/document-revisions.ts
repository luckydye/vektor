import { verifyAccess, verifyRevisionAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
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
import { updateDocument } from "#db/space/documents.ts";
import {
  getRevisionMetadata,
  listRevisionMetadata,
  restoreRevision,
  updateRevisionStatus,
} from "#db/space/revisions.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { replaceLiveDocumentContent } from "#realtime/yjsRooms.ts";

/**
 * List the revisions of a document
 *
 * @tag Documents
 * @paginated
 * @response array #/components/schemas/Revision
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      user.id,
      Permission.VIEWER,
    );

    // No revision is named, so no snapshot exemption: VIEW_HISTORY is required.
    await verifyRevisionAccess(spaceId, documentId, user.id);

    const store = await openSpaceStore(spaceId);
    const revisions = await listRevisionMetadata(store, documentId);

    return jsonResponse({ revisions });
  }, "Failed to list revisions");

/**
 * Create a revision, or restore an earlier one
 *
 * @tag Documents
 * @body
 * @status 201
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    // Authorized before the query is read: a caller who may not edit this
    // document should get that verdict, not a complaint about `rev`.
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      user.id,
      Permission.EDITOR,
    );

    const revParam = new URL(context.req.url).searchParams.get("rev");
    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }

    const rev = parseQueryInt(new URL(context.req.url).searchParams, "rev", { min: 1 });

    const body = await parseJsonBodyOrEmpty<{ message?: string }>(context.req.raw);
    const message = typeof body.message === "string" ? body.message : undefined;
    const store = await openSpaceStore(spaceId);
    const restored = await restoreRevision(store, documentId, rev, user.id, message);
    if (!restored) {
      throw notFoundResponse("Revision");
    }

    const { revision, content } = restored;
    const document = await updateDocument(store, documentId, content);
    if (!document) {
      throw notFoundResponse("Document");
    }
    replaceLiveDocumentContent(spaceId, documentId, document.type, content);
    sendSyncEvent(spaceId, realtimeTopics.document(documentId));

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

/**
 * Update a revision's message or suggestion status
 *
 * @tag Documents
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    // Authorized before the query is read: a caller who may not edit this
    // document should get that verdict, not a complaint about `rev`.
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      user.id,
      Permission.EDITOR,
    );

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
