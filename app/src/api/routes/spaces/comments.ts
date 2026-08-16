import { inArray } from "drizzle-orm";
import { verifyDocumentAccess, verifyFeatureAccess } from "#acl/guards.ts";
import { Feature, Permission, ResourceType } from "#acl/permissions.ts";
import { getUserGroups, hasPermission } from "#acl/store.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb, getSpaceDb } from "#db/client/db.ts";
import { many } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user as userTable } from "#db/schema/auth.ts";
import { createAuditLog } from "#db/space/auditLogs.ts";
import {
  archiveComment,
  archiveComments,
  createComment,
  getComment,
  listComments,
  updateCommentReferences,
} from "#db/space/comments.ts";
import { enqueueCommentCreatedEmails } from "#notifications/enqueue.ts";
import { appLogger } from "#observability/logger.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = context.var.user;
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = new URL(context.req.url).searchParams.get("documentId");

    if (!documentId) {
      throw badRequestResponse("documentId is required");
    }

    // Allow viewing comments if user has access to document (including public docs)
    await verifyDocumentAccess(spaceId, documentId, user?.id || null);

    const store = await openSpaceStore(spaceId);
    const comments = await listComments(store, ResourceType.DOCUMENT, documentId);

    // Fetch user data for comment creators. Only id/name/image — the client
    // renders the author name and an id-seeded avatar; email is PII and is
    // never needed here, so it is not selected or returned.
    const authDb = getAuthDb();
    const userIds = [...new Set(comments.map((c) => c.createdBy))];
    const users = await many(
      authDb
        .select({ id: userTable.id, name: userTable.name, image: userTable.image })
        .from(userTable)
        .where(inArray(userTable.id, userIds)),
    );

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

    const body = await parseJsonBody(context.req.raw);
    const { content, parentId, type, reference, documentId } = body;

    if (!documentId || typeof documentId !== "string") {
      throw badRequestResponse("documentId is required");
    }

    // Ensure user has access to document
    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Verify user has commenting feature access. Scoped to the document, or a
    // document/tree/category-scoped editor would be refused on a document they
    // may edit outright — same reasoning as the suggestion gate in document.ts.
    await verifyFeatureAccess(spaceId, Feature.COMMENT, user.id, documentId);

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

    const store = await openSpaceStore(spaceId);
    const comment = await createComment(
      store,
      ResourceType.DOCUMENT,
      documentId,
      content,
      user.id,
      typeof parentId === "string" ? parentId : null,
      typeof type === "string" ? type : undefined,
      typeof reference === "string" ? reference : undefined,
    );

    await createAuditLog(store, {
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
        commentContent: comment.content,
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

    const body = await parseJsonBody(context.req.raw);
    const { commentIds, reference, archived, documentId } = body;

    if (!documentId || typeof documentId !== "string") {
      throw badRequestResponse("documentId is required");
    }

    await verifyDocumentAccess(spaceId, documentId, user.id);
    await verifyFeatureAccess(spaceId, Feature.COMMENT, user.id, documentId);

    if (
      !Array.isArray(commentIds) ||
      commentIds.length === 0 ||
      !commentIds.every((id) => typeof id === "string")
    ) {
      throw badRequestResponse("Comment IDs are required");
    }

    // Reject the whole request if any id is outside this document. PATCH is a
    // bulk thread operation, so silently dropping ids would leave a partially
    // archived or split thread.
    const store = await openSpaceStore(spaceId);
    const comments = await listComments(store, ResourceType.DOCUMENT, documentId);
    const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
    const validIds = [...new Set(commentIds)];
    const requestedComments = validIds.map((id) => {
      const comment = commentsById.get(id);
      if (!comment) throw notFoundResponse("Comment");
      return comment;
    });

    // Editors may maintain whole threads. Commenters may only modify their own
    // comments, matching DELETE's authorship rule.
    const canModerate = await hasPermission(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      user.id,
      Permission.EDITOR,
      await getUserGroups(user.id),
    );
    if (
      !canModerate &&
      requestedComments.some((comment) => comment.createdBy !== user.id)
    ) {
      throw forbiddenResponse("You can only update your own comments");
    }

    if (archived === true) {
      await archiveComments(store, validIds);

      sendSyncEvent(spaceId, {
        topic: realtimeTopics.document(documentId),
        data: { kind: "comment_deleted", commentIds: validIds, documentId },
      });
    } else {
      if (!reference || typeof reference !== "string" || !reference.trim()) {
        throw badRequestResponse("Reference is required");
      }

      await updateCommentReferences(store, validIds, reference);

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

    const body = await parseJsonBody(context.req.raw);
    const { commentId, documentId } = body;

    if (!documentId || typeof documentId !== "string") {
      throw badRequestResponse("documentId is required");
    }

    // As early as the body allows: `documentId` is the subject of the check, so it
    // has to be read first, but nothing else does — an outsider is turned away
    // before the rest of the shape is validated.
    await verifyDocumentAccess(spaceId, documentId, user.id);
    await verifyFeatureAccess(spaceId, Feature.COMMENT, user.id, documentId);

    if (!commentId || typeof commentId !== "string") {
      throw badRequestResponse("Comment ID is required");
    }

    // Get the comment and verify user is the creator. Scoped to the document
    // the gates above authorized: a bare id lookup would archive a comment on
    // some other document, so the caller could name whichever document they may
    // comment on and reach a comment anywhere in the space.
    const store = await openSpaceStore(spaceId);
    const comment = await getComment(store, commentId, documentId);
    if (!comment) {
      throw notFoundResponse("Comment");
    }

    if (comment.createdBy !== user.id) {
      throw forbiddenResponse("You can only delete your own comments");
    }

    await archiveComment(store, commentId);

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
