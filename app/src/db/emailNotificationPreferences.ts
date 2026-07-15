import { and, eq, inArray } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { preference } from "./schema/space.ts";

const DOCUMENT_EMAIL_MUTED_KEY_PREFIX = "email.document_muted:";

function documentEmailMutedKey(documentId: string): string {
  return `${DOCUMENT_EMAIL_MUTED_KEY_PREFIX}${documentId}`;
}

export async function isDocumentEmailMuted(
  spaceId: string,
  documentId: string,
  userId: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select({ id: preference.id })
    .from(preference)
    .where(
      and(
        eq(preference.key, documentEmailMutedKey(documentId)),
        eq(preference.userId, userId),
      ),
    )
    .get();
  return !!row;
}

export async function getDocumentEmailMutedUserIds(
  spaceId: string,
  documentId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select({ userId: preference.userId })
    .from(preference)
    .where(
      and(
        eq(preference.key, documentEmailMutedKey(documentId)),
        inArray(preference.userId, userIds),
      ),
    )
    .all();

  return new Set(rows.flatMap(({ userId }) => (userId ? [userId] : [])));
}

export async function setDocumentEmailMuted(
  spaceId: string,
  documentId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const key = documentEmailMutedKey(documentId);

  if (!muted) {
    await db
      .delete(preference)
      .where(and(eq(preference.key, key), eq(preference.userId, userId)));
    return;
  }

  const existing = await db
    .select({ id: preference.id })
    .from(preference)
    .where(and(eq(preference.key, key), eq(preference.userId, userId)))
    .get();
  const now = new Date();

  if (existing) {
    await db
      .update(preference)
      .set({ value: "true", updatedAt: now })
      .where(eq(preference.id, existing.id));
    return;
  }

  await db.insert(preference).values({
    id: createId("preference"),
    key,
    value: "true",
    userId,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteDocumentEmailPreferences(
  spaceId: string,
  documentId: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db
    .delete(preference)
    .where(eq(preference.key, documentEmailMutedKey(documentId)));
}
