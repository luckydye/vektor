import { and, eq, inArray } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { preference } from "./schema/space.ts";

const DOCUMENT_EMAIL_MUTED_KEY_PREFIX = "email.document_muted:";
const SPACE_EMAIL_MUTED_KEY = "email.space_muted";

function emailMutedKey(documentId?: string): string {
  return documentId
    ? `${DOCUMENT_EMAIL_MUTED_KEY_PREFIX}${documentId}`
    : SPACE_EMAIL_MUTED_KEY;
}

/**
 * A document-level preference overrides the space-wide default when set;
 * otherwise the space-wide default applies. Neither set means "not muted".
 */
export async function isEmailMuted(
  spaceId: string,
  userId: string,
  documentId?: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  if (documentId) {
    const documentRow = await db
      .select({ value: preference.value })
      .from(preference)
      .where(
        and(eq(preference.key, emailMutedKey(documentId)), eq(preference.userId, userId)),
      )
      .get();
    if (documentRow) return documentRow.value === "true";
  }

  const spaceRow = await db
    .select({ value: preference.value })
    .from(preference)
    .where(and(eq(preference.key, emailMutedKey()), eq(preference.userId, userId)))
    .get();
  return spaceRow?.value === "true";
}

export async function getEmailMutedUserIds(
  spaceId: string,
  userIds: string[],
  documentId?: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const db = await getSpaceDb(spaceId);

  const spaceRows = await db
    .select({ userId: preference.userId, value: preference.value })
    .from(preference)
    .where(and(eq(preference.key, emailMutedKey()), inArray(preference.userId, userIds)))
    .all();
  const resolved = new Map<string, boolean>();
  for (const { userId, value } of spaceRows) {
    if (userId) resolved.set(userId, value === "true");
  }

  if (documentId) {
    const documentRows = await db
      .select({ userId: preference.userId, value: preference.value })
      .from(preference)
      .where(
        and(
          eq(preference.key, emailMutedKey(documentId)),
          inArray(preference.userId, userIds),
        ),
      )
      .all();
    for (const { userId, value } of documentRows) {
      if (userId) resolved.set(userId, value === "true");
    }
  }

  return new Set(
    [...resolved.entries()].filter(([, muted]) => muted).map(([userId]) => userId),
  );
}

export async function setEmailMuted(
  spaceId: string,
  userId: string,
  muted: boolean,
  documentId?: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const key = emailMutedKey(documentId);

  const existing = await db
    .select({ id: preference.id })
    .from(preference)
    .where(and(eq(preference.key, key), eq(preference.userId, userId)))
    .get();
  const now = new Date();

  if (existing) {
    await db
      .update(preference)
      .set({ value: muted ? "true" : "false", updatedAt: now })
      .where(eq(preference.id, existing.id));
    return;
  }

  await db.insert(preference).values({
    id: createId("preference"),
    key,
    value: muted ? "true" : "false",
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
  await db.delete(preference).where(eq(preference.key, emailMutedKey(documentId)));
}
