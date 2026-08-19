import { and, asc, eq, inArray } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { comment } from "#db/schema/space.ts";

export type Comment = typeof comment.$inferSelect;

export async function createComment(
  s: SpaceStore,
  resourceType: string,
  resourceId: string,
  content: string,
  createdBy: string,
  parentId: string | null = null,
  type: string = "comment",
  reference?: string,
): Promise<Comment> {
  const id = createId("comment");
  const now = new Date();

  const [newComment] = await s.db
    .insert(comment)
    .values({
      id,
      parentId,
      type,
      content,
      createdAt: now,
      updatedAt: now,
      createdBy,
      resourceType,
      resourceId,
      archived: false,
      reference,
    })
    .returning();

  if (!newComment) {
    throw new Error("Failed to create comment");
  }

  return newComment;
}

export async function listComments(
  s: SpaceStore,
  resourceType: string,
  resourceId: string,
): Promise<Comment[]> {
  return s.db
    .select()
    .from(comment)
    .where(
      and(
        eq(comment.resourceType, resourceType),
        eq(comment.resourceId, resourceId),
        eq(comment.archived, false),
      ),
    )
    .orderBy(asc(comment.createdAt));
}

export async function getComment(
  s: SpaceStore,
  commentId: string,
): Promise<Comment | undefined> {
  const [foundComment] = await s.db
    .select()
    .from(comment)
    .where(eq(comment.id, commentId));

  return foundComment;
}

export async function updateCommentReferences(
  s: SpaceStore,
  commentIds: string[],
  reference: string,
): Promise<void> {
  await s.db
    .update(comment)
    .set({ reference, updatedAt: new Date() })
    .where(inArray(comment.id, commentIds));
}

export async function archiveComment(s: SpaceStore, commentId: string): Promise<void> {
  await s.db
    .update(comment)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(comment.id, commentId));
}

export async function archiveComments(
  s: SpaceStore,
  commentIds: string[],
): Promise<void> {
  if (commentIds.length === 0) return;
  await s.db
    .update(comment)
    .set({ archived: true, updatedAt: new Date() })
    .where(inArray(comment.id, commentIds));
}

/**
 * A comment's `reference` is a JSON blob whose `selector` identifies the
 * anchored text; two comments are in the same thread when their selectors
 * match. Falls back to the raw string for references that predate that shape.
 */
function normalizeCommentReference(reference: string | null): string | null {
  if (!reference) return null;
  try {
    const parsed = JSON.parse(reference) as { selector?: unknown };
    return typeof parsed.selector === "string" ? parsed.selector : reference;
  } catch {
    return reference;
  }
}

/** Authors of every non-archived comment anchored to the same thread. */
export async function listThreadParticipantIds(
  s: SpaceStore,
  documentId: string,
  reference: string | null,
  parentId: string | null,
): Promise<string[]> {
  const parent = parentId
    ? await s.db
        .select({ createdBy: comment.createdBy, reference: comment.reference })
        .from(comment)
        .where(
          and(
            eq(comment.id, parentId),
            eq(comment.resourceType, "document"),
            eq(comment.resourceId, documentId),
          ),
        )
        .get()
    : undefined;
  const normalizedReference = normalizeCommentReference(
    reference ?? parent?.reference ?? null,
  );
  if (!normalizedReference) return [];

  const rows = await s.db
    .select({ createdBy: comment.createdBy, reference: comment.reference })
    .from(comment)
    .where(
      and(
        eq(comment.resourceType, "document"),
        eq(comment.resourceId, documentId),
        eq(comment.archived, false),
      ),
    )
    .all();

  return [
    ...(parent ? [parent.createdBy] : []),
    ...rows
      .filter((row) => normalizeCommentReference(row.reference) === normalizedReference)
      .map(({ createdBy }) => createdBy),
  ];
}
