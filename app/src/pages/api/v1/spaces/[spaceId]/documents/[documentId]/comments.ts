import type { APIRoute } from "astro";
import { inArray } from "drizzle-orm";
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
import {
  createComment,
  listComments,
  getComment,
  archiveComment,
} from "#db/comments.ts";
import { ResourceType, Feature } from "#db/acl.ts";
import { getAuthDb } from "#db/db.ts";
import { user as userTable } from "#db/schema/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = context.locals.user;
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    // Allow viewing comments if user has access to document (including public docs)
    await verifyDocumentAccess(spaceId, documentId, user?.id || null);

    const comments = await listComments(spaceId, ResourceType.DOCUMENT, documentId);

    // Fetch user data for comment creators
    const authDb = getAuthDb();
    const userIds = [...new Set(comments.map((c) => c.createdBy))];
    const users = await authDb
      .select()
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
              email: commentUser.email,
              image: commentUser.image,
            }
          : null,
      };
    });

    return jsonResponse({ comments: enrichedComments });
  }, "Failed to list comments");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    // Ensure user has access to document
    await verifyDocumentAccess(spaceId, documentId, user.id);

    // Verify user has commenting feature access
    await verifyFeatureAccess(spaceId, Feature.COMMENT, user.id);

    const body = await parseJsonBody(context.request);
    const { content, parentId, type, reference } = body;

    if (!content || typeof content !== "string") {
      throw badRequestResponse("Content is required");
    }

    if (parentId && typeof parentId !== "string") {
      throw badRequestResponse("Parent ID must be a string");
    }

    const comment = await createComment(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      content,
      user.id,
      parentId || null,
      type,
      reference,
    );

    return jsonResponse({ comment });
  }, "Failed to create comment");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    const body = await parseJsonBody(context.request);
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
    return jsonResponse({ success: true });
  }, "Failed to delete comment");
