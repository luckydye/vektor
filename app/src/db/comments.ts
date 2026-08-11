import { and, asc, eq, inArray } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { comment } from "./schema/space.ts";

export type Comment = typeof comment.$inferSelect;

export async function createComment(
  spaceId: string,
  resourceType: string,
  resourceId: string,
  content: string,
  createdBy: string,
  parentId: string | null = null,
  type: string = "comment",
  reference?: string,
): Promise<Comment> {
  const db = await getSpaceDb(spaceId);
  const id = createId("comment");
  const now = new Date();

  const [newComment] = await db
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
  spaceId: string,
  resourceType: string,
  resourceId: string,
): Promise<Comment[]> {
  const db = await getSpaceDb(spaceId);

  return db
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
  spaceId: string,
  commentId: string,
): Promise<Comment | undefined> {
  const db = await getSpaceDb(spaceId);

  const [foundComment] = await db.select().from(comment).where(eq(comment.id, commentId));

  return foundComment;
}

export async function updateCommentReferences(
  spaceId: string,
  commentIds: string[],
  reference: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db
    .update(comment)
    .set({ reference, updatedAt: new Date() })
    .where(inArray(comment.id, commentIds));
}

export async function archiveComment(spaceId: string, commentId: string): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db
    .update(comment)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(comment.id, commentId));
}

export async function archiveComments(
  spaceId: string,
  commentIds: string[],
): Promise<void> {
  if (commentIds.length === 0) return;
  const db = await getSpaceDb(spaceId);
  await db
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
  spaceId: string,
  documentId: string,
  reference: string | null,
  parentId: string | null,
): Promise<string[]> {
  const db = await getSpaceDb(spaceId);
  const parent = parentId
    ? await db
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

  const rows = await db
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
