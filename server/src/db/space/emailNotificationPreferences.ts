import { and, eq, inArray } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference } from "#db/schema/space.ts";
import { preferenceKey, spacePreferenceNamespaces } from "#utils/spacePreferences.ts";

// Per-member preferences, so they live in the `user:` namespace of the space
// preference store and are stored against the member's own `userId`. The keys
// name the mute rather than the channel carrying it: email is what delivers a
// notification today, not what the member asked to stop hearing about.
const DOCUMENT_MUTED_KEY_PREFIX = preferenceKey(
  spacePreferenceNamespaces.user,
  "document_muted:",
);
const SPACE_MUTED_KEY = preferenceKey(spacePreferenceNamespaces.user, "space_muted");

function emailMutedKey(documentId?: string): string {
  return documentId ? `${DOCUMENT_MUTED_KEY_PREFIX}${documentId}` : SPACE_MUTED_KEY;
}

/**
 * A document-level preference overrides the space-wide default when set;
 * otherwise the space-wide default applies. Neither set means "not muted".
 */
export async function isEmailMuted(
  s: SpaceStore,
  userId: string,
  documentId?: string,
): Promise<boolean> {
  if (documentId) {
    const documentRow = await one(
      s.db
        .select({ value: preference.value })
        .from(preference)
        .where(
          and(
            eq(preference.key, emailMutedKey(documentId)),
            eq(preference.userId, userId),
          ),
        ),
    );
    if (documentRow) return documentRow.value === "true";
  }

  const spaceRow = await one(
    s.db
      .select({ value: preference.value })
      .from(preference)
      .where(and(eq(preference.key, emailMutedKey()), eq(preference.userId, userId))),
  );
  return spaceRow?.value === "true";
}

export async function getEmailMutedUserIds(
  s: SpaceStore,
  userIds: string[],
  documentId?: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const spaceRows = await many(
    s.db
      .select({ userId: preference.userId, value: preference.value })
      .from(preference)
      .where(
        and(eq(preference.key, emailMutedKey()), inArray(preference.userId, userIds)),
      ),
  );
  const resolved = new Map<string, boolean>();
  for (const { userId, value } of spaceRows) {
    if (userId) resolved.set(userId, value === "true");
  }

  if (documentId) {
    const documentRows = await many(
      s.db
        .select({ userId: preference.userId, value: preference.value })
        .from(preference)
        .where(
          and(
            eq(preference.key, emailMutedKey(documentId)),
            inArray(preference.userId, userIds),
          ),
        ),
    );
    for (const { userId, value } of documentRows) {
      if (userId) resolved.set(userId, value === "true");
    }
  }

  return new Set(
    [...resolved.entries()].filter(([, muted]) => muted).map(([userId]) => userId),
  );
}

export async function setEmailMuted(
  s: SpaceStore,
  userId: string,
  muted: boolean,
  documentId?: string,
): Promise<void> {
  const key = emailMutedKey(documentId);

  const existing = await one(
    s.db
      .select({ id: preference.id })
      .from(preference)
      .where(and(eq(preference.key, key), eq(preference.userId, userId))),
  );
  const now = new Date();

  if (existing) {
    await s.db
      .update(preference)
      .set({ value: muted ? "true" : "false", updatedAt: now })
      .where(eq(preference.id, existing.id));
    return;
  }

  await s.db.insert(preference).values({
    id: createId("preference"),
    key,
    value: muted ? "true" : "false",
    userId,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteDocumentEmailPreferences(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  await s.db.delete(preference).where(eq(preference.key, emailMutedKey(documentId)));
}
