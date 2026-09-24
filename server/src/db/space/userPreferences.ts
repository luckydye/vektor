import { and, eq, like } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference } from "#db/schema/space.ts";
import { preferenceKey, spacePreferenceNamespaces } from "#utils/spacePreferences.ts";

/**
 * A member's own preferences for a space: the `user:` namespace of the same
 * preference store, kept in rows carrying their `userId` instead of the null the
 * space's own preferences use.
 *
 * Two stores in one table, and the split matters both ways: a space write must
 * not reach a member's rows, and a member's rows must not ride along in the
 * space payload, which is shared and cached by space id.
 */

/** `user:` — every key these functions read and write starts with it. */
const USER_NAMESPACE_PREFIX = preferenceKey(spacePreferenceNamespaces.user, "");

/**
 * Everything this member has stored for the space, keyed as it was written
 * (`user:…`), so a caller reads it with the same key it writes.
 */
export async function getUserPreferences(
  s: SpaceStore,
  userId: string,
): Promise<Record<string, string>> {
  const rows = await many(
    s.db
      .select({ key: preference.key, value: preference.value })
      .from(preference)
      .where(
        and(
          eq(preference.userId, userId),
          like(preference.key, `${USER_NAMESPACE_PREFIX}%`),
        ),
      ),
  );

  // Through a `Map`, for the reason `getSpace` uses one: a key is user-supplied,
  // and bracket assignment would drop a `__proto__` preference on the floor.
  return Object.fromEntries(new Map(rows.map((row) => [row.key, row.value])));
}

/** One member's preference, written against their own user id. */
async function setUserPreference(
  s: SpaceStore,
  userId: string,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date();
  const existing = await one(
    s.db
      .select({ id: preference.id })
      .from(preference)
      .where(and(eq(preference.key, key), eq(preference.userId, userId))),
  );

  if (existing) {
    await s.db
      .update(preference)
      .set({ value, updatedAt: now })
      .where(eq(preference.id, existing.id));
    return;
  }

  await s.db.insert(preference).values({
    id: createId("preference"),
    key,
    value,
    userId,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Store this member's preferences, leaving the ones the write does not mention.
 * Only `user:` keys belong here; the space write path filters the rest out
 * (`splitPreferencesByScope`).
 */
export async function setUserPreferences(
  s: SpaceStore,
  userId: string,
  preferences: Record<string, string>,
): Promise<void> {
  for (const [key, value] of Object.entries(preferences)) {
    if (!key.startsWith(USER_NAMESPACE_PREFIX)) continue;
    await setUserPreference(s, userId, key, value);
  }
}
