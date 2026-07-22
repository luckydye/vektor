import { inArray } from "drizzle-orm";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { Feature, ResourceType } from "#db/acl.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  verifyFeatureAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { createAuditLog } from "#db/auditLogs.ts";
import {
  archiveComment,
  archiveComments,
  createComment,
  getComment,
  listComments,
  updateCommentReferences,
} from "#db/comments.ts";
import { getAuthDb, getSpaceDb } from "#db/db.ts";
import { enqueueCommentCreatedEmails } from "#db/emailNotifications.ts";
import { user as userTable } from "#db/schema/auth.ts";
import { sendSyncEvent } from "#db/ws.ts";
import { appLogger } from "#observability/logger.ts";
import { realtimeTopics } from "#utils/realtime.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = context.var.user;
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    // Allow viewing comments if user has access to document (including public docs)
    await verifyDocumentAccess(spaceId, documentId, user?.id || null);

    const comments = await listComments(spaceId, ResourceType.DOCUMENT, documentId);

    // Fetch user data for comment creators. Only id/name/image — the client
    // renders the author name and an id-seeded avatar; email is PII and is
    // never needed here, so it is not selected or returned.
    const authDb = getAuthDb();
    const userIds = [...new Set(comments.map((c) => c.createdBy))];
    const users = await authDb
      .select({ id: userTable.id, name: userTable.name, image: userTable.image })
      .from(userTable)
      .where(inArray(userTable.id, userIds))
      .all();

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Enrich comments with user data
    const enrichedComments = comments.map((comment) => {
      const commentUser = userMap.get(comment.createdBy);
      return {
        ...comment,
        createdByUser: commentUser
          ? {
              id: commentUser.id,
              name: commentUser.name,
              image: commentUser.image,
            }
          : null,
      };
    });

    return jsonResponse({ comments: enrichedComments });
  }, "Failed to list comments");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    // Ensure user has access to document
    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Verify user has commenting feature access
    await verifyFeatureAccess(spaceId, Feature.COMMENT, user.id);

    const body = await parseJsonBody(context.req.raw);
    const { content, parentId, type, reference } = body;

    if (!content || typeof content !== "string") {
      throw badRequestResponse("Content is required");
    }

    if (parentId && typeof parentId !== "string") {
      throw badRequestResponse("Parent ID must be a string");
    }

    if (reference !== undefined && reference !== null && typeof reference !== "string") {
      throw badRequestResponse("Reference must be a string");
    }

    if (!parentId && (!reference || typeof reference !== "string" || !reference.trim())) {
      throw badRequestResponse("Reference is required for top-level comments");
    }

    const comment = await createComment(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      content,
      user.id,
      typeof parentId === "string" ? parentId : null,
      typeof type === "string" ? type : undefined,
      typeof reference === "string" ? reference : undefined,
    );

    await createAuditLog(await getSpaceDb(spaceId), {
      spaceId,
      docId: documentId,
      userId: user.id,
      event: "comment",
      details: {
        message: "Comment created",
        commentId: comment.id,
        parentId: comment.parentId,
        reference: comment.reference,
      },
    });

    try {
      await enqueueCommentCreatedEmails({
        spaceId,
        documentId,
        commentId: comment.id,
        commentReference: comment.reference,
        commentParentId: comment.parentId,
        actorId: user.id,
      });
    } catch (error) {
      appLogger.error("Failed to enqueue comment emails", {
        error,
        spaceId,
        documentId,
        commentId: comment.id,
      });
    }

    sendSyncEvent(spaceId, {
      topic: realtimeTopics.document(documentId),
      data: {
        kind: "comment_created",
        commentId: comment.id,
        documentId,
        parentId: comment.parentId,
        reference: comment.reference ?? null,
      },
    });

    return jsonResponse({ comment });
  }, "Failed to create comment");

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, user.id);
    await verifyFeatureAccess(spaceId, Feature.COMMENT, user.id);

    const body = await parseJsonBody(context.req.raw);
    const { commentIds, reference, archived } = body;

    if (
      !Array.isArray(commentIds) ||
      commentIds.length === 0 ||
      !commentIds.every((id) => typeof id === "string")
    ) {
      throw badRequestResponse("Comment IDs are required");
    }

    // Only operate on comments that belong to this document
    const comments = await listComments(spaceId, ResourceType.DOCUMENT, documentId);
    const documentCommentIds = new Set(comments.map((c) => c.id));
    const validIds = commentIds.filter((id) => documentCommentIds.has(id));
    if (validIds.length === 0) {
      throw notFoundResponse("Comment");
    }

    if (archived === true) {
      await archiveComments(spaceId, validIds);

      sendSyncEvent(spaceId, {
        topic: realtimeTopics.document(documentId),
        data: { kind: "comment_deleted", commentIds: validIds, documentId },
      });
    } else {
      if (!reference || typeof reference !== "string" || !reference.trim()) {
        throw badRequestResponse("Reference is required");
      }

      await updateCommentReferences(spaceId, validIds, reference);

      sendSyncEvent(spaceId, {
        topic: realtimeTopics.document(documentId),
        data: { kind: "comment_updated", commentIds: validIds, documentId, reference },
      });
    }

    return jsonResponse({ success: true });
  }, "Failed to update comments");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    const body = await parseJsonBody(context.req.raw);
    const { commentId } = body;

    if (!commentId || typeof commentId !== "string") {
      throw badRequestResponse("Comment ID is required");
    }

    // Verify user has access to document
    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Get the comment and verify user is the creator
    const comment = await getComment(spaceId, commentId);
    if (!comment) {
      throw notFoundResponse("Comment");
    }

    if (comment.createdBy !== user.id) {
      throw forbiddenResponse("You can only delete your own comments");
    }

    await archiveComment(spaceId, commentId);

    sendSyncEvent(spaceId, {
      topic: realtimeTopics.document(documentId),
      data: {
        kind: "comment_deleted",
        commentId,
        documentId,
        parentId: comment.parentId,
        reference: comment.reference ?? null,
      },
    });

    return jsonResponse({ success: true });
  }, "Failed to delete comment");
