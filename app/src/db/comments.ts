import { and, asc, eq } from "drizzle-orm";
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

export async function archiveComment(spaceId: string, commentId: string): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db
    .update(comment)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(comment.id, commentId));
}
