import { and, eq } from "drizzle-orm";
import { one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference } from "#db/schema/space.ts";
import { preferenceKey, spacePreferenceNamespaces } from "#utils/spacePreferences.ts";

// What the agent has worked out about a member: written only by the agent, and
// read from the row carrying that member's `userId`. A request setting
// `ai:user_profile` writes the space's row instead, which nothing reads.
const PROFILE_KEY = preferenceKey(spacePreferenceNamespaces.ai, "user_profile");

export async function getUserProfile(
  s: SpaceStore,
  userId: string,
): Promise<string | null> {
  const row = await one(
    s.db
      .select()
      .from(preference)
      .where(and(eq(preference.key, PROFILE_KEY), eq(preference.userId, userId))),
  );
  return row?.value ?? null;
}

export async function setUserProfile(
  s: SpaceStore,
  userId: string,
  profile: string,
): Promise<void> {
  const now = new Date();
  const existing = await one(
    s.db
      .select()
      .from(preference)
      .where(and(eq(preference.key, PROFILE_KEY), eq(preference.userId, userId))),
  );

  if (existing) {
    await s.db
      .update(preference)
      .set({ value: profile, updatedAt: now })
      .where(eq(preference.id, existing.id));
  } else {
    await s.db.insert(preference).values({
      id: createId("preference"),
      key: PROFILE_KEY,
      value: profile,
      userId,
      createdAt: now,
      updatedAt: now,
    });
  }
}
